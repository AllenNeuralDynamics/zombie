/**
 * paginated-table.js — Utility helpers for paginated, sortable, filterable tables
 *
 * Extracts common UI building blocks shared across smartspim, sessions, and assets views.
 * Each helper generates HTML for a specific table component.
 */

import { escHtml, uniqueValues, PAGE_SIZE } from './utils.js';

/**
 * Build <thead> HTML with sortable headers and filter inputs.
 *
 * @param {string[]} columns - Column keys
 * @param {Record<string, string>} columnLabels - Column key → display label
 * @param {string} sortCol - Currently sorted column
 * @param {'asc'|'desc'} sortDir - Current sort direction
 * @param {Record<string, string>} filterValues - Current filter values
 * @param {object[]} rows - All data rows (for computing unique values)
 * @param {Record<string, 'text'|'select'>} [filterTypes={}] - Column filter UI type
 * @param {number} [selectThreshold=40] - Min uniques to show select vs input
 * @param {string[]} [skipFilterColumns=[]] - Columns that don't get filter inputs
 * @returns {string} <thead> HTML string
 */
export function buildTableHead(
  columns,
  columnLabels,
  sortCol,
  sortDir,
  filterValues,
  rows,
  filterTypes = {},
  selectThreshold = 40,
  skipFilterColumns = [],
) {
  const headerCells = columns.map((col) => {
    const label = columnLabels[col] || col;
    const arrow = sortCol === col ? (sortDir === 'asc' ? '▲' : '▼') : '';
    const filterHtml = skipFilterColumns.includes(col) ? '' : buildFilterInput(col, filterValues[col] || '', rows, filterTypes[col], selectThreshold);

    return `<th class="sortable" data-col="${escHtml(col)}">
      <span class="col-label">${escHtml(label)} ${arrow}</span>
      ${filterHtml}
    </th>`;
  });

  return `<thead><tr>${headerCells.join('')}</tr></thead>`;
}

/**
 * Build a filter input or select element for a column.
 *
 * @param {string} col - Column key
 * @param {string} filterValue - Current filter value
 * @param {object[]} rows - All data rows
 * @param {'text'|'select'} [forceType] - Force this UI type (ignores selectThreshold)
 * @param {number} [selectThreshold=40] - Min uniques to use select
 * @returns {string} HTML element (input or select)
 */
export function buildFilterInput(col, filterValue = '', rows = [], forceType = undefined, selectThreshold = 40) {
  const uniques = uniqueValues(rows, col);
  const useSelect = forceType === 'select' || (forceType !== 'text' && uniques.length > 0 && uniques.length < selectThreshold);

  if (useSelect) {
    const options = uniques.map((val) => `<option value="${escHtml(val)}" ${filterValue === val ? 'selected' : ''}>${escHtml(val)}</option>`).join('');
    return `<select class="col-filter" data-col="${escHtml(col)}">
      <option value="">All</option>
      ${options}
    </select>`;
  }

  return `<input type="text" class="col-filter" data-col="${escHtml(col)}"
    value="${escHtml(filterValue)}" placeholder="Filter..." />`;
}

/**
 * Build a paging bar with Prev/Next buttons and info text.
 *
 * @param {number} page - Current page number (0-indexed)
 * @param {number} pageSize - Rows per page (e.g., PAGE_SIZE)
 * @param {number} total - Total number of visible (filtered) rows
 * @param {string} [prevButtonId='prev-page'] - ID for previous button
 * @param {string} [nextButtonId='next-page'] - ID for next button
 * @returns {string} HTML for paging bar
 */
export function buildPagingBar(page, pageSize, total, prevButtonId = 'prev-page', nextButtonId = 'next-page') {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  const prevDisabled = page === 0 ? 'disabled' : '';
  const nextDisabled = page >= totalPages - 1 ? 'disabled' : '';

  return `<div class="paging-bar">
    <button id="${prevButtonId}" ${prevDisabled}>← Prev</button>
    <span class="paging-info">${start}–${end} of ${total}</span>
    <button id="${nextButtonId}" ${nextDisabled}>Next →</button>
  </div>`;
}
