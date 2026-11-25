// codesignflo resolve <component> --design | --code "<why>" — settles a clash: the designer changed
// something that the code also changed since the claim (sync reports "N conflicting").
//   --design  the designer's version wins (default rule: the panel warned them and they sent it anyway);
//             the clashing changes are delivered like the others
//   --code    the code's version stays; the proposal goes back to the designer with the reason
import { fold, resolveEvents } from "@codesignflo/core";
import { appendLedger, readLedger } from "../project.js";

export async function resolve(args: string[]): Promise<number> {
  const component = args.find((a) => !a.startsWith("--"));
  const take = args.includes("--design") ? "design" : args.includes("--code") ? "code" : null;
  const reason = take === "code" ? args[args.indexOf("--code") + 1] : undefined;
  if (!component || !take || (take === "code" && (!reason || reason.startsWith("--"))))
    throw new Error('usage: codesignflo resolve <component> --design | --code "<why the code version stays>"');
  const st = fold(readLedger()).get(component);
  if (!st) throw new Error(`${component} has no proposal ready for dev`);
  appendLedger(resolveEvents(st, take, reason));
  console.log(
    take === "design"
      ? `${component}: the designer's version wins — run codesignflo sync, then deliver it (the clashing changes are included)`
      : `${component}: kept the code's version; sent back to the designer with your reason (they see it at the next sync)`,
  );
  return 0;
}
