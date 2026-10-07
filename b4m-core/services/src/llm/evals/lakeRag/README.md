# Lake RAG subject-agnostic eval fixtures

This fixture set is pure data plus a deterministic scorer for data-lake retrieval. It does not create lakes, call the database, call the network, or call an LLM. The live driver that uploads these files to a real lake belongs to issue 3978.

## Layout

- `corpus/<subject>/**/*.md` contains the source documents. Each markdown file has `date:` frontmatter because the same files are meant to be uploaded unchanged later.
- `bank.json` contains the question bank.
- `grade.ts` scores a model reply against one bank row.

The subjects are intentionally unrelated so each subject can later act as a distractor lake for the others in a multi-lake retrieval run.

## Planted stale cases

Each subject includes these cases:

- `stale-same-name`: upload the older document first and the newer document second while preserving the same original file name. The corpus stores them in separate directories so git can keep both files, but the live uploader should upload both with the shared basename.
- `stale-different-name`: upload an older and newer document with different file names. The older document contains a conflicting stale value.
- `absent`: ask for a detail that is not present in that subject lake. The correct behavior is to say the lake does not contain the answer.

Upload order matters for `stale-same-name`: older first, newer second.

## Bank row shape

Rows contain:

- `id`
- `subject`
- `kind`: `fact`, `stale-same-name`, `stale-different-name`, or `absent`
- `question`
- `expect`: answer tokens or regex patterns that must match the reply
- `expectSource`: expected cited file name, or `null` for absent-answer cases
- `rejectTokens`: stale values that must not appear in the reply

When scoring indexed citations, `[N]` resolves to `promptMeta.citables[N - 1]` and the resolved source basename must match `expectSource`.
