# Worker questions carry each option's cost

- Status: done

User, 2026-11-15: a merge-queue design question reached the chat as bare labels ("Wait 30 min then hold (Recommended)" | "Land directly"). Nothing said that 30 minutes would stall every branch behind the queue head, so the user had to ask. A worker question now carries, for each option, a one-line consequence (what happens if it is picked, what waits or is blocked, what breaks if it is wrong) and, for its recommendation, the main downside. The user sees both wherever they answer.

## What a worker must give

- `flowryn ask`: one `--consequence "<option>: <text>"` per option (repeatable; an option name never holds a colon, so the first colon splits it), and with `--recommend` a `--downside <text>`. `--recommend` must now be one of the options. Each line is at most 200 characters after control characters are stripped and whitespace is collapsed. A missing, stray, doubled, empty or long one is refused before anything is written. The refusal names the problem and gives a whole example ask in its help line. This covers `ask --nomistakes` too.
- A review gate's `questions.json` (design, QA and draft stages): each option of a single or multi question is `{"label": "...", "consequence": "..."}`, and the question has `"recommended_downside"`. A bare-string option is refused with an example object. A text question has no options; its `recommended_downside` is optional.
- The worker contract's ask line, the build skill's ask and the design skill's `questions.json` example and rule say so. The contract and design-skill size budgets went up by the few characters this needs (`test/unit/harness.test.ts`, `test/unit/instruction-budgets.test.ts`, `test/unit/prompts-that-keep.test.ts`).

One check, `checkOptionCosts` (`src/lifecycle/decisions.ts`), serves both entry points. Each caller frames the problem with its own example.

## Where it shows

- Storage: migration 63 adds `decisions.consequences` (JSON keyed by option) and `decisions.downside`. Both are null on older rows and on the leader's standalone decisions (k<N>, `decision add`, a scout report's decisions). These are not worker questions, and nothing requires costs of them.
- `flowryn chat-question q<N>`: each option's description is its consequence. The recommended option keeps "(Recommended)" in its label, and its description ends with ". Downside: …". A multi choice marks and costs each recommended option, so the "(Recommended)" label now also appears on multi questions. A decision without costs keeps the old `Record "<option>" as your answer to q<N>` text. The binding (labels, choices, hash) is unchanged: both hooks rebuild the same form.
- The review page widget (`flowryn-questions.js`): a line under each option with its consequence, and "Downside: …" after the recommended option's line or the text question's default. The text goes in through `textContent`, so worker markup stays text. Older questions show no line.

## Security

Consequences and downsides are worker-written, untrusted text. They are capped at 200 characters and refused past that. Rendering sanitizes them again (`optionCostsOf`), and the page sets them only as text. An unreadable stored value shows the fallback text rather than failing the form.

## Not changed

- PROTO: the flags are additive and the envelope is unchanged. A CLI without them gets the daemon's refusal and its example.
- Contract revisions: the contract suite's `ask` step is `dispatch --kind ask`, not the worker verb.
- The leader's relaying is out of scope. That is left to the leader's own preferences.
