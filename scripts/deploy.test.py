import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
REVISION = 'a' * 40


class DeploymentTest(unittest.TestCase):
    def deploy(self, failure=''):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            project = root / 'production'
            (project / 'server/config').mkdir(parents=True)
            (project / '.env').write_text('IMAGE_TAG=old\nPOSTGRES_PASSWORD=private\n')
            (project / 'server/config/catalog.json').write_text('private catalog')
            (project / 'docker-compose.yml').write_text('old compose')
            binary = root / 'bin'
            binary.mkdir()
            fake = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
a = sys.argv[1:]
with open(os.environ['CALLS'], 'a') as log:
    log.write(json.dumps(a) + '\n')
if a[0] == 'image' and os.environ['FAILURE'] == 'missing': sys.exit(1)
if a[0] == 'image': print(os.environ['REVISION'])
elif a[0] == 'inspect':
    print('sha256:old-' + a[-1] if a[2] == '{{.Image}}' else 'mutable:latest')
elif 'ps' in a: print(a[-1])
elif 'pg_dump' in a: print('-- backup')
elif 'port' in a: print('0.0.0.0:3015')
elif 'up' in a and os.environ['FAILURE'] == 'start':
    count = pathlib.Path(os.environ['CALLS'] + '.started')
    if not count.exists():
        count.touch()
        sys.exit(1)
'''
            (binary / 'docker').write_text(fake)
            (binary / 'curl').write_text(r'''#!/bin/sh
[ "$FAILURE" != health ] || exit 1
printf '{"ok":true}'
''')
            for file in binary.iterdir(): file.chmod(0o755)
            calls = root / 'calls'
            env = {**os.environ, 'PATH': f'{binary}:{os.environ["PATH"]}', 'HOME': str(root), 'CALLS': str(calls), 'FAILURE': failure, 'REVISION': REVISION}
            result = subprocess.run(['bash', str(ROOT / 'scripts/deploy.sh'), REVISION, str(project), '1797127235/Canvas'], env=env, capture_output=True, text=True)
            self.assertEqual((project / '.env').read_text(), 'IMAGE_TAG=old\nPOSTGRES_PASSWORD=private\n')
            self.assertEqual((project / 'server/config/catalog.json').read_text(), 'private catalog')
            commands = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
            override = project / 'docker-compose.deploy.yml'
            return result, commands, override.read_text() if override.exists() else '', (project / 'docker-compose.yml').read_text(), list((project / 'backups').glob('*')) if (project / 'backups').exists() else []

    def test_success_pins_both_images_without_restarting_database(self):
        result, calls, override, compose, backups = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'sha-{REVISION}', override)
        self.assertIn('services:', compose)
        self.assertEqual(len(backups), 1)
        up = next(call for call in calls if 'up' in call)
        self.assertIn('--no-deps', up)
        self.assertIn('--force-recreate', up)
        self.assertIn('--wait', up)
        self.assertEqual(up[-2:], ['api', 'web'])
        self.assertFalse(any('down' in call or 'prune' in call or call[0] == 'pull' for call in calls))

    def test_missing_image_leaves_existing_release_untouched(self):
        result, calls, override, compose, backups = self.deploy('missing')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(compose, 'old compose')
        self.assertEqual(override, '')
        self.assertFalse(any('up' in call for call in calls))
        self.assertEqual(backups, [])

    def test_start_failure_restores_original_compose_and_images(self):
        result, calls, override, compose, _ = self.deploy('start')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(compose, 'old compose')
        self.assertIn('sha256:old-api', override)
        self.assertIn('sha256:old-web', override)
        self.assertEqual(len([call for call in calls if 'up' in call]), 2)

    def test_health_failure_rolls_back_and_does_not_report_success(self):
        result, calls, override, compose, _ = self.deploy('health')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(compose, 'old compose')
        self.assertIn('sha256:old-api', override)
        self.assertEqual(len([call for call in calls if 'up' in call]), 2)

    def test_invalid_revision_is_rejected_before_accessing_production(self):
        result = subprocess.run(['bash', str(ROOT / 'scripts/deploy.sh'), 'main;touch /tmp/unsafe'], capture_output=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
