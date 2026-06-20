# a//y Control Actions — Implementation Plan

## Problem
The a//y chat widget on the assets page currently can only display text responses. We want it to control the page — filter tables, navigate between pages, trigger queries, etc. — without polluting the backend prompt with control commands when it's also doing complex MCP queries.

## Solution Design

### Architecture

```
User message → Chat Server (/chat endpoint)
    │
    ├─ [Intent Router — fast model (Haiku/4o-mini)]
    │   "Is this a control request or a data query?"
    │   Reads ally-actions.json schema
    │   ~200 tokens overhead per request
    │
    ├─ control request
    │   ↓
    │   [Control extraction prompt]
    │   "Which action(s) from ally-actions.json fit this message?"
    │   ↓
    │   Backend: { response, actions }  ← NEW SHAPE
    │
    └─ MCP/data request
        ↓
        [Existing MCP pipeline — unchanged]
        ↓
        Backend: { response }
```

### Key Principles

1. **Single source of truth for actions**: `web/public/ally-actions.json`
   - Server fetches at startup (cache if needed)
   - Defines schema, enums, descriptions
   - Also serves as documentation for the chat server

2. **Two-stage backend pipeline**:
   - Router: fast, cheap classification
   - Extraction: lightweight JSON generation (if control request)
   - Keeps MCP prompt clean (no pollution)

3. **Frontend is action-agnostic**:
   - `mountChatWidget` accepts a `controller` parameter
   - Dispatches actions by type name: `controller.dispatch(action)`
   - If no controller provided, gracefully no-ops (backwards compatible)

---

## Implementation Tasks

### Frontend — Phase 1: Static Files & Schema

- [ ] **Create `web/public/ally-actions.json`**
  - Define all actions (set_filter, clear_filters, navigate, open_query_builder, set_query_fields, run_query)
  - Include descriptions, param schemas, enums
  - Version field for compatibility tracking
  - Status: Ready to implement

### Frontend — Phase 2: Expose Controller from Assets Page

- [ ] **Refactor `createAssetsView(coord)` to return `{ el, controller }`**
  - Extract table state management into a `controller` object with methods:
    - `setFilter(column, value)` → updates internal filters, refreshes table, syncs URL
    - `clearFilters()` → resets all filters, refreshes, syncs URL
    - `navigate(url)` → `window.location.href`
    - `openQueryBuilder()` → expand QB if collapsed
    - `setQueryFields(fields)` → populate QB form controls
    - `runQuery(mongoFilter)` → POST to `/retrieve-records` endpoint
    - `dispatch(action)` → router that calls the appropriate method
  - All existing functionality preserved; just wrapped in a public API

- [ ] **Update `assets-entry.js` to pass controller to widget**
  ```js
  const { el, controller } = createAssetsView(coord);
  container.appendChild(el);
  mountChatWidget({ controller });
  ```

### Frontend — Phase 3: Update Chat Widget

- [ ] **Modify `mountChatWidget({ controller })` to dispatch actions**
  - After each chat response, check for `data.actions` array
  - For each action: `controller?.dispatch(action)`
  - Graceful fallback if controller not provided (backwards compatible)

### Backend: Implementation (Out of Scope for This Plan)

- Implement two-stage router in the `/chat` endpoint
  - Fast model reads ally-actions.json schema
  - Routes to control extraction or MCP pipeline
  - Control path returns `{ response, actions }`
- Keep MCP prompt unchanged; add separate control/routing prompts

---

## Testing Strategy

### Unit Tests
- `buildQueryBuilder()` still works as before (no change to signature)
- Controller methods (setFilter, clearFilters, navigate, etc.) behave correctly
- Dispatch router handles unknown action types gracefully

### Integration Tests
- assets page loads with controller
- widget mounts with controller
- chat response with `{ response, actions }` correctly dispatches

### Manual Test Scenarios
1. "Show me only SmartSPIM assets" → `set_filter(modalities, smartspim)`
2. "Clear all filters" → `clear_filters`
3. "Take me to the subject page" → `navigate(/subject)`
4. "Find raw data from project Foo" → `set_query_fields + open_query_builder`

---

## File Locations

| File | Purpose | Status |
|------|---------|--------|
| `web/public/ally-actions.json` | Schema + actions registry | To create |
| `web/src/assets/view.js` | Expose controller from `createAssetsView` | To refactor |
| `web/src/assets-entry.js` | Pass controller to widget | To update |
| `web/src/lib/chat-widget.js` | Dispatch actions from responses | To update |

---

## Backwards Compatibility

- Old responses without `actions` field: widget ignores, displays text only ✓
- Widget without controller provided: `controller?.dispatch()` no-ops ✓
- Other pages that don't call `createAssetsView`: unaffected ✓

---

## Known Constraints

- Query builder is only on assets page; future work to add to other pages
- Scope: assets page only (as noted in `assets-entry.js`)
- Backend implementation (router + prompts) is separate effort

