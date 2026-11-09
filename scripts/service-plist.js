// Prints the launchd plist for the Pocket Dev service. install-service.sh calls it; the text comes from platform.js.
// Usage: node scripts/service-plist.js --node <node> --repo <folder>   (LABEL, PORT and LOG come from the environment)
import { platform } from '../platform.js';

const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
const plan = platform.servicePlan({ node: flag('--node'), repo: flag('--repo'), port: process.env.PORT, label: process.env.LABEL, log: process.env.LOG });
process.stdout.write(plan.files[0].content);
