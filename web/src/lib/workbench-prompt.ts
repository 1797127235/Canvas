let pendingPrompt = "";

export function stageWorkbenchPrompt(prompt: string) {
    pendingPrompt = prompt;
}

export function takeWorkbenchPrompt() {
    const prompt = pendingPrompt;
    pendingPrompt = "";
    return prompt;
}
