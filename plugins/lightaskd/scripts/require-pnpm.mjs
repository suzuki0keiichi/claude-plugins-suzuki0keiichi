const userAgent = process.env.npm_config_user_agent ?? "";

if (!userAgent.startsWith("pnpm/")) {
  console.error("explicit-taskbox is pnpm-only. Use pnpm; npm and yarn are not supported.");
  process.exit(1);
}
