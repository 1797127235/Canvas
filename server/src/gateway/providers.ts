import { gateway } from "./index.js";
import { c2aProvider } from "./providers/C2A/index.js";
import { agnesProvider } from "./providers/AgnesAI/index.js";

export const registerProvider = gateway.registerProvider;
registerProvider(c2aProvider);
registerProvider(agnesProvider);
