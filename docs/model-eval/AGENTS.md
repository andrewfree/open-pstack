# Model evaluation lab

Use Python 3 standard library only. No installs, generation APIs, model launchers,
telemetry, credential reads, uploads, or automatic live calls. Users explicitly
select local files for import. Preserve their source logs and existing outputs.

Read CONTRACT.md and the relevant module guide before changing behavior. Unknown
measurements and prices remain null with a reason. Keep synthetic verification,
observational imports, and controlled trials separate. Synthetic examples must
use source_kind=synthetic and never serve as live evidence. Caller-supplied
provenance is not independently verified model or host attestation.

Do not commit usage logs, imported metadata, private paths, local configuration,
thread/session IDs, receipts, raw responses, or generated reports. Keep outputs
under ignored out/ unless the caller explicitly selects another private path.
Public research contains dated official source links; do not silently refresh
rates or remap exact model IDs. cases/suite.json is immutable under its existing
version and SHA-256; a revision needs a new suite identity.

Follow the root comments policy. Preserve public API and external protocol
contracts; remove narration that merely repeats executable logic.

After changes run python3 -m unittest discover -s tests -q, CLI --help,
cases --prompts, and the synthetic cost example in README.md. These checks never
authorize or substitute for a live model experiment.
