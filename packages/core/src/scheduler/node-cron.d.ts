/** Minimal type declarations for node-cron@3. */
declare module "node-cron" {
  interface ScheduledTask {
    start(): void;
    stop(): void;
  }

  function schedule(expression: string, func: () => void): ScheduledTask;
  function validate(expression: string): boolean;

  export { schedule, validate };
  export default { schedule, validate };
}
