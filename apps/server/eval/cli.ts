// Bootstrap：在加载任何用 logger 的模块前先设置 LOG_LEVEL。
//   ES module 的 import 是先解析的，所以 runner.ts 里的 process.env 赋值"来不及"。
//   想看完整日志：LOG_LEVEL=info pnpm eval
process.env.LOG_LEVEL ??= 'warn';
await import('./runner.ts');
