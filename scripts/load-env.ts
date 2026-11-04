import {loadEnvConfig} from "@next/env";
// Match Next's .env.local loading for backend CLI commands.
loadEnvConfig(process.cwd());
