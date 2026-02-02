import { existsSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import type { ValidationRule } from "./types.js";

export interface ValidationResult {
  passed: boolean;
  message?: string;
}

export function validateRule(
  rule: ValidationRule,
  workdir: string
): ValidationResult {
  switch (rule.type) {
    case "file_exists": {
      const fullPath = join(workdir, rule.path);
      const exists = existsSync(fullPath);
      return {
        passed: exists,
        message: exists ? undefined : `File not found: ${rule.path}`,
      };
    }

    case "file_not_empty": {
      const fullPath = join(workdir, rule.path);
      if (!existsSync(fullPath)) {
        return { passed: false, message: `File not found: ${rule.path}` };
      }
      const stat = statSync(fullPath);
      return {
        passed: stat.size > 0,
        message: stat.size > 0 ? undefined : `File is empty: ${rule.path}`,
      };
    }

    case "file_contains": {
      const fullPath = join(workdir, rule.path);
      if (!existsSync(fullPath)) {
        return { passed: false, message: `File not found: ${rule.path}` };
      }
      const content = readFileSync(fullPath, "utf-8");
      const contains = content.includes(rule.pattern);
      return {
        passed: contains,
        message: contains
          ? undefined
          : `File ${rule.path} does not contain: ${rule.pattern}`,
      };
    }

    case "file_matches": {
      const fullPath = join(workdir, rule.path);
      if (!existsSync(fullPath)) {
        return { passed: false, message: `File not found: ${rule.path}` };
      }
      const content = readFileSync(fullPath, "utf-8");
      const regex = new RegExp(rule.regex);
      const matches = regex.test(content);
      return {
        passed: matches,
        message: matches
          ? undefined
          : `File ${rule.path} does not match regex: ${rule.regex}`,
      };
    }

    case "command_succeeds": {
      try {
        execSync(rule.command, { cwd: workdir, stdio: "pipe" });
        return { passed: true };
      } catch (err) {
        return {
          passed: false,
          message: `Command failed: ${rule.command}`,
        };
      }
    }

    case "custom": {
      // Custom validators loaded dynamically
      return { passed: false, message: "Custom validators not yet implemented" };
    }

    default:
      return { passed: false, message: `Unknown rule type` };
  }
}

export function validateAll(
  rules: ValidationRule[],
  workdir: string
): Array<{ rule: ValidationRule; result: ValidationResult }> {
  return rules.map((rule) => ({
    rule,
    result: validateRule(rule, workdir),
  }));
}
