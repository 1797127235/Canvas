const CHANNEL_NAME = "infinite-canvas-auth";

type AuthEvent = "login" | "logout" | "session-expired";

let channel: BroadcastChannel | null = null;

export function publishAuthEvent(type: AuthEvent) {
    if (typeof BroadcastChannel === "undefined") return;
    channel ||= new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ type });
}

export function subscribeAuthEvents(onEvent: (type: AuthEvent) => void) {
    if (typeof BroadcastChannel === "undefined") return () => undefined;
    channel ||= new BroadcastChannel(CHANNEL_NAME);
    const listener = (event: MessageEvent<{ type?: AuthEvent }>) => {
        if (event.data?.type === "login" || event.data?.type === "logout" || event.data?.type === "session-expired") onEvent(event.data.type);
    };
    channel.addEventListener("message", listener);
    return () => channel?.removeEventListener("message", listener);
}
