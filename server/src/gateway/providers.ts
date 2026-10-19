import { gateway } from "./index.js";
import { c2aProvider } from "./providers/C2A/index.js";

export const registerProvider = gateway.registerProvider;
registerProvider(c2aProvider);
