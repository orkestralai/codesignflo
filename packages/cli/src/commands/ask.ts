// codesignflo ask <component> "<question>" — sends a ready proposal back to the designer with a question
// (something unclear before implementing). They see it in the panel and answer by editing and re-sending.
import { askEvent, fold } from "@codesignflo/core";
import { appendLedger, readLedger } from "../project.js";

export async function ask(args: string[]): Promise<number> {
  const [component, question] = args.filter((a) => !a.startsWith("--"));
  if (!component || !question?.trim()) throw new Error('usage: codesignflo ask <component> "<question for the designer>"');
  const st = fold(readLedger()).get(component);
  if (!st) throw new Error(`${component} has no proposal ready for dev`);
  appendLedger([askEvent(st, question)]);
  console.log(`${component}: question sent to the designer (they see it at the next sync)`);
  return 0;
}
