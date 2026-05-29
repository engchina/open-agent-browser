import { checkLicenses, listInstalledPackages } from "./license-policy.js";

const packages = listInstalledPackages(process.cwd());
const violations = checkLicenses(packages);

if (violations.length > 0) {
  console.error("License check failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`License check passed for ${packages.length} installed packages.`);
