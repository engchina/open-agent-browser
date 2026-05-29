import { scanWorkspaceForCleanRoomViolations } from "./clean-room-policy.js";

const violations = scanWorkspaceForCleanRoomViolations(process.cwd());

if (violations.length > 0) {
  console.error("Clean-room check failed:");
  for (const violation of violations) {
    console.error(`- ${violation.path}: ${violation.rule} matched ${JSON.stringify(violation.match)}`);
  }
  process.exit(1);
}

console.log("Clean-room check passed.");
