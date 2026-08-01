---
id: E10-T06
epic: 10
title: Media, artifact, and evidence references
priority: 1006
status: pending
depends_on: [E10-T03]
estimate: L
capstone: false
---

## Goal

Messages, runs, workflows, and project cards can attach immutable, authorization-aware
references to files, images, Replay recordings, MP4s, logs, and evidence bundles with
verified content hashes and safe browser presentation.

## Context

Evidence is a reference to immutable bytes, not pasted trust. Metadata, previews, search,
download, and recording playback must reauthorize and must never leak signed URLs,
credentials, or hidden attachment existence.

## Deliverables

- Versioned artifact-reference schema, hash/size/media metadata, and provenance links.
- Authorized upload/finalize/read doors with bounded preview and download behavior.
- Room/run/search rendering for artifacts, Replay links, and same-session MP4 pairs.
- Tamper, content-type, range, ACL, browser, Replay, and digest tests.

## Acceptance criteria

- [ ] Finalization verifies bytes, SHA-256, size, media type, owner, source run, and stream
      boundary; immutable references cannot be repointed to different bytes.
- [ ] Unauthorized users learn no filename, type, size, hash, preview, signed URL, or
      existence through direct ids, search, ranges, embeds, or error differences.
- [ ] Unsafe HTML/SVG/script/polyglot content is downloaded or sandboxed under the frozen
      policy and cannot execute in the app origin or exfiltrate credentials.
- [ ] Replay and MP4 evidence pairs include a shared run/session manifest and verified
      hashes; mismatched media cannot be presented as same-session proof.
- [ ] The final upload/reference/search/view journey has Replay and same-session MP4,
      zero console errors, and artifact/source offsets/digests matching independent replay.

## Adversarial verification

1. Swap, truncate, mutate, and race bytes around finalization; any accepted hash mismatch
   or mutable reference refutes evidence integrity.
2. Probe hidden attachments through ids, search, ranges, caching, redirects, and response
   timing; one metadata or byte leak refutes authorization.
3. Upload active/polyglot content with forged MIME/extension and open every preview path;
   script execution or app-origin access refutes isolation.
4. Pair Replay and MP4 from different sessions and corrupt one manifest hash; a green
   verifier or credible UI presentation refutes media provenance.

## Verification log
