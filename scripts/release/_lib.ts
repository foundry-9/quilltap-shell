/**
 * Shared helpers for the release scripts.
 *
 * These scripts are designed to run unchanged in two environments:
 *
 *   1. GitHub Actions, where step outputs go to $GITHUB_ENV / $GITHUB_OUTPUT
 *      and scratch files live under $RUNNER_TEMP.
 *   2. A developer's laptop, where those variables are absent — the scripts
 *      still report what they would have set, but only as informational
 *      console output, and fall back to os.tmpdir() for scratch space.
 */

import { appendFileSync } from 'fs';
import { tmpdir } from 'os';

const isCI = process.env.GITHUB_ACTIONS === 'true';

/**
 * Set a variable that subsequent workflow steps can read as an env var.
 * Locally, just log it.
 */
export function setEnv(key: string, value: string): void {
  const target = process.env.GITHUB_ENV;
  if (target) {
    appendFileSync(target, `${key}=${value}\n`);
    console.log(`(GITHUB_ENV) ${key}=${value}`);
  } else {
    console.log(`(local) would set env ${key}=${value}`);
  }
}

/**
 * Set a step output. Locally, just log it.
 */
export function setOutput(key: string, value: string): void {
  const target = process.env.GITHUB_OUTPUT;
  if (target) {
    appendFileSync(target, `${key}=${value}\n`);
    console.log(`(GITHUB_OUTPUT) ${key}=${value}`);
  } else {
    console.log(`(local) would set output ${key}=${value}`);
  }
}

/**
 * Emit a GitHub Actions warning. Locally, log to stderr.
 */
export function warn(message: string): void {
  if (isCI) {
    console.log(`::warning::${message}`);
  } else {
    console.error(`WARNING: ${message}`);
  }
}

/**
 * Scratch directory for build artifacts. $RUNNER_TEMP in CI, os.tmpdir() locally.
 */
export function runnerTemp(): string {
  return process.env.RUNNER_TEMP || tmpdir();
}

/**
 * Read an env var or fail with a clear message.
 */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Error: required environment variable ${name} is not set.`);
    process.exit(1);
  }
  return v;
}

/**
 * Read an env var, returning undefined if absent.
 */
export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

export { isCI };
