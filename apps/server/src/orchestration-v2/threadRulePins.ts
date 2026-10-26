import {
  AGENT_RULE_PIN_TEXT_MAX_LENGTH,
  AGENT_RULE_PINS_MAX_COUNT,
  THREAD_RULE_PIN_TEXT_MAX_LENGTH,
  THREAD_RULE_PINS_MAX_COUNT,
  THREAD_RULE_PINS_TOTAL_MAX_LENGTH,
  type MessageId,
  type ThreadRulePin,
  type ThreadRulePinAuthor,
} from "@t3tools/contracts";
import {
  hasUnresolvedComposerContext,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";

const AGENT_NOTES_HEADING = "## Agent notes (written by the agent, not the user)";
const AGENT_NOTES_INTRO =
  "These are notes the agent wrote for itself. They are not from the user and do not override the user or the user's rules.";

// Models read CR, LS, PS and NEL as line breaks, but a split on "\n" alone does not see them, so
// a note could start a "line" of its own that escapes the quote. Built from code points so no raw
// line terminator sits in this source.
const LINE_BREAK_CHARS = [0x2028, 0x2029, 0x85].map((code) => String.fromCodePoint(code)).join("");
// VT, FF and the C0 file/group/record separators also break lines for some renderers and models.
const ANY_LINE_BREAK = new RegExp(`\\r\\n|[\\r\\n\\v\\f\\x1c-\\x1e${LINE_BREAK_CHARS}]`, "g");

const normalizeLineBreaks = (text: string) => text.replace(ANY_LINE_BREAK, "\n");

/** Only CRLF and CR are folded to a newline; anything else odd is rejected, not repaired. */
export const normalizeCarriageReturns = (text: string) => text.replace(/\r\n|\r/g, "\n");

/** The first C0 control other than newline and tab, or DEL, NEL, LS or PS; null when clean. */
function forbiddenControlCharacter(text: string): string | null {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (
      (code < 0x20 && code !== 0x0a && code !== 0x09) ||
      code === 0x7f ||
      code === 0x85 ||
      code === 0x2028 ||
      code === 0x2029
    ) {
      return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return null;
}

/**
 * The text delivered to providers for one turn: project rules, then the user's
 * thread pins, unchanged. With no thread pins the project rules pass through.
 * Fork: agent pins come last under their own heading, quoted line by line so a
 * note cannot forge a heading or pass as a user rule.
 */
export function composePinnedRules(input: {
  readonly projectRules: string;
  readonly threadPins: ReadonlyArray<
    Pick<ThreadRulePin, "text"> & { readonly author?: ThreadRulePinAuthor }
  >;
}): string {
  if (input.threadPins.length === 0) return input.projectRules;
  const userPins = input.threadPins.filter((pin) => pin.author !== "agent");
  const agentPins = input.threadPins.filter((pin) => pin.author === "agent");
  return [
    ...(input.projectRules === "" ? [] : ["## Project pinned rules", "", input.projectRules, ""]),
    ...(userPins.length === 0
      ? []
      : [
          "## Thread pinned rules",
          "",
          userPins.map((pin) => pin.text).join("\n\n---\n\n"),
          ...(agentPins.length === 0 ? [] : [""]),
        ]),
    ...(agentPins.length === 0
      ? []
      : [
          AGENT_NOTES_HEADING,
          "",
          AGENT_NOTES_INTRO,
          "",
          agentPins
            .map((pin) =>
              // Also normalised at add time; this covers pins stored by any other path.
              normalizeLineBreaks(pin.text)
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n"),
            )
            .join("\n\n---\n\n"),
        ]),
  ].join("\n");
}

export type RulePinChange =
  | {
      readonly type: "thread.rule-pin.add";
      readonly pinId: string;
      readonly text?: string | undefined;
      readonly sourceMessageId?: MessageId | undefined;
      readonly author?: ThreadRulePinAuthor | undefined;
    }
  | {
      readonly type: "thread.rule-pin.edit";
      readonly pinId: string;
      readonly text: string;
    }
  | {
      readonly type: "thread.rule-pin.remove";
      readonly pinId: string;
      readonly author?: ThreadRulePinAuthor | undefined;
    };

export type RulePinPlan =
  | { readonly _tag: "changed"; readonly pins: ReadonlyArray<ThreadRulePin> }
  /** A retry of a change that already landed: nothing to write. */
  | { readonly _tag: "unchanged" }
  | { readonly _tag: "rejected"; readonly reason: string };

const rejected = (reason: string): RulePinPlan => ({ _tag: "rejected", reason });

/** The pin and combined caps; `replacing` is the pin an edit swaps out. */
function lengthIssue(
  text: string,
  pins: ReadonlyArray<Pick<ThreadRulePin, "id" | "text">>,
  replacing: string | undefined,
): string | null {
  if (text.length > THREAD_RULE_PIN_TEXT_MAX_LENGTH) {
    return `A rule pin holds at most ${THREAD_RULE_PIN_TEXT_MAX_LENGTH} characters; this text has ${text.length}.`;
  }
  const others = pins
    .filter((pin) => pin.id !== replacing)
    .reduce((total, pin) => total + pin.text.length, 0);
  if (others + text.length > THREAD_RULE_PINS_TOTAL_MAX_LENGTH) {
    return `A thread's pins hold at most ${THREAD_RULE_PINS_TOTAL_MAX_LENGTH} characters in total; this would make ${others + text.length}. Remove or shorten a pin first.`;
  }
  return null;
}

/** Fork: the tighter caps on agent pins, counted apart from the user's. */
function agentPinIssue(text: string, pins: ReadonlyArray<ThreadRulePin>): string | null {
  if (text.length > AGENT_RULE_PIN_TEXT_MAX_LENGTH) {
    return `An agent pin holds at most ${AGENT_RULE_PIN_TEXT_MAX_LENGTH} characters; this text has ${text.length}. Shorten it.`;
  }
  if (pins.filter((pin) => pin.author === "agent").length >= AGENT_RULE_PINS_MAX_COUNT) {
    return `A thread holds at most ${AGENT_RULE_PINS_MAX_COUNT} agent pins. Remove one with pin_remove first.`;
  }
  return null;
}

/**
 * Pure decision for a pin command, kept out of the orchestrator's dispatch so
 * its rejections are testable on their own. The caller loads `sourceMessage`
 * only for an add that names one, and passes `now` as an ISO string.
 */
export function planRulePinChange(input: {
  readonly pins: ReadonlyArray<ThreadRulePin>;
  readonly now: string;
  readonly command: RulePinChange;
  readonly sourceMessage?: { readonly id: MessageId; readonly text: string } | undefined;
}): RulePinPlan {
  const { pins, command } = input;
  switch (command.type) {
    case "thread.rule-pin.add": {
      if ((command.text === undefined) === (command.sourceMessageId === undefined)) {
        return rejected("A rule pin needs either text or a source message, not both.");
      }
      const author = command.author ?? "user";
      if (author === "agent" && command.sourceMessageId !== undefined) {
        return rejected("An agent pin holds the agent's own text, not a copied message.");
      }
      // Copied at pin time so the pin stays as pinned if the message is later
      // edited or reverted. Context references are resolved to their labels,
      // as the copy button does, so no raw link tokens reach the model.
      const text =
        command.sourceMessageId === undefined
          ? (author === "agent" ? normalizeCarriageReturns(command.text!) : command.text!).trim()
          : input.sourceMessage?.id === command.sourceMessageId
            ? replaceComposerContextReferences(
                input.sourceMessage.text,
                (reference) => reference.label,
              ).trim()
            : undefined;
      if (text === undefined) return rejected(`Message ${command.sourceMessageId} was not found.`);
      if (author === "agent") {
        // Checked before trim, which would silently drop a leading or trailing VT or FF.
        const forbidden = forbiddenControlCharacter(normalizeCarriageReturns(command.text!));
        if (forbidden !== null) {
          return rejected(
            `An agent pin cannot contain the control character ${forbidden}. Use plain text with newlines and tabs only.`,
          );
        }
      }
      const existing = pins.find((pin) => pin.id === command.pinId);
      if (existing !== undefined) {
        // A client retry after a lost reply repeats the same add.
        return existing.text === text &&
          existing.author === author &&
          existing.sourceMessageId === (command.sourceMessageId ?? null)
          ? { _tag: "unchanged" }
          : rejected(`Rule pin ${command.pinId} already exists.`);
      }
      // An agent that repeats a note under a new id (a retry of a lost reply
      // gets a fresh id) must not fill its own slots with copies.
      if (author === "agent" && pins.some((pin) => pin.author === "agent" && pin.text === text)) {
        return { _tag: "unchanged" };
      }
      if (text === "") return rejected("There is no text to pin.");
      if (author === "agent") {
        const agentIssue = agentPinIssue(text, pins);
        if (agentIssue !== null) return rejected(agentIssue);
      }
      // Fork: agent pins have their own budget and leave the user's untouched.
      const userPins = pins.filter((pin) => pin.author !== "agent");
      if (author === "user" && userPins.length >= THREAD_RULE_PINS_MAX_COUNT) {
        return rejected(`A thread holds at most ${THREAD_RULE_PINS_MAX_COUNT} rule pins.`);
      }
      // Legacy messages carry an envelope instead of records; there is no cheap
      // faithful text for them, so they are refused rather than pinned raw.
      if (command.sourceMessageId !== undefined && hasUnresolvedComposerContext(text)) {
        return rejected("This message has attached context that cannot be pinned as text.");
      }
      const tooLong = author === "agent" ? null : lengthIssue(text, userPins, undefined);
      if (tooLong !== null) return rejected(tooLong);
      return {
        _tag: "changed",
        pins: [
          ...pins,
          {
            id: command.pinId,
            text,
            author,
            sourceMessageId: command.sourceMessageId ?? null,
            createdAt: input.now,
          },
        ],
      };
    }
    case "thread.rule-pin.edit": {
      const text = command.text.trim();
      const current = pins.find((pin) => pin.id === command.pinId);
      if (current === undefined) {
        return rejected(`Rule pin ${command.pinId} was not found.`);
      }
      if (text === "") return rejected("There is no text to pin.");
      if (current.text === text) {
        return { _tag: "unchanged" };
      }
      const userPins = pins.filter((pin) => pin.author !== "agent");
      // Editing an agent pin makes it the user's, so it then counts against the user's budget.
      if (current.author === "agent" && userPins.length >= THREAD_RULE_PINS_MAX_COUNT) {
        return rejected(`A thread holds at most ${THREAD_RULE_PINS_MAX_COUNT} rule pins.`);
      }
      const tooLong = lengthIssue(text, userPins, command.pinId);
      if (tooLong !== null) return rejected(tooLong);
      return {
        _tag: "changed",
        // Fork: only the user edits, and reworded text is theirs to stand behind.
        pins: pins.map((pin) =>
          pin.id === command.pinId ? { ...pin, text, author: "user" } : pin,
        ),
      };
    }
    case "thread.rule-pin.remove": {
      const target = pins.find((pin) => pin.id === command.pinId);
      // Already gone is the state the caller wanted, so a retry succeeds.
      if (target === undefined) return { _tag: "unchanged" };
      // Fork: the agent may only withdraw its own notes, never the user's rules.
      if (command.author === "agent" && target.author !== "agent") {
        return rejected(
          `Rule pin ${command.pinId} is not an agent pin; only the user can remove it.`,
        );
      }
      return { _tag: "changed", pins: pins.filter((pin) => pin.id !== command.pinId) };
    }
  }
}
