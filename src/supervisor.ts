/**
 * Supervisor entry (see `supervisor-main.ts`). From source, Node loads `.lua`
 * only through the hook, so the hook is in place before the import.
 */
import { registerHooks } from "node:module";

import { loadLuaText } from "./loaders/lua-text.ts";

registerHooks({ load: loadLuaText });
await import("./supervisor-main.ts");
