---
name: zombie-view-and-navigation
description: Maintain Zombie's combined subject/project view, URL synchronization, DocDB loading, asset timelines, and embedded child views.
---

# Zombie view and navigation

`/view` is composed by `web/src/combined/view.js` from `createProjectView()` and `createSubjectView()` with `embedded: true`. The combined view owns URL/history state and passes imperative `loadProject()`/`loadSubject()` calls to the children. Canonical parameters are `subject_id`, `project`, and `asset`; accept `project_name` as the legacy alias. Open the project section when `project` is set or no subject is selected; open the subject section when `subject_id` is set. Use the existing `openSubject`, `openProject`, `highlightSubject`, and `highlightAsset` callbacks instead of adding independent navigation state.

Subject data comes from `queryDocDb({'subject.subject_id': subjectId}, {signal})`; the view organizes subject, procedures, instruments, and acquisitions, excludes derived assets from the subject timeline, then enriches records with `asset_basics`. Project data uses `fetchAssetsWithSources()` for the raw/non-derived timeline and the full asset set for its table. Reuse `buildTimelineSvg()`, `buildAssetsTable()`, and `renderEventDetail()`.

Every reload owns an `AbortController`, checks `signal.aborted` after each await, and ignores stale results. Preserve URL parameters for project colors, time windows, and curricula (`color_by`, `window_size`, `window_start`, `curricula`). The embedded children must not take over browser history or render a second page shell. Test query-to-view state with mocked DocDB/coordinator calls and abort stale requests.
