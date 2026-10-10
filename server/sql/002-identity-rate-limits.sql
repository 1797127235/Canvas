CREATE TABLE identity_rate_limits (
    key VARCHAR(255) PRIMARY KEY,
    points INTEGER NOT NULL DEFAULT 0,
    expire BIGINT
);

CREATE INDEX identity_rate_limits_expire_idx ON identity_rate_limits (expire);
