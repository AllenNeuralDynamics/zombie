import { describe, it, expect } from 'vitest';
import { buildTableHead, buildFilterInput, buildPagingBar } from '../lib/paginated-table.js';

describe('buildTableHead', () => {
  it('generates header with sort arrows', () => {
    const html = buildTableHead(
      ['name', 'email'],
      { name: 'Name', email: 'Email' },
      'name',
      'asc',
      { name: '', email: '' },
      [],
      {},
      40,
      [],
    );
    expect(html).toContain('Name ▲');
    expect(html).toContain('Email');
    expect(html).toContain('data-col="name"');
    expect(html).toContain('data-col="email"');
  });

  it('skips filter inputs for specified columns', () => {
    const html = buildTableHead(
      ['name', 'email'],
      { name: 'Name', email: 'Email' },
      'name',
      'asc',
      { name: '', email: '' },
      [],
      {},
      40,
      ['email'],
    );
    expect(html).toContain('col-filter');
    expect(html.match(/col-filter/g).length).toBe(1);
  });

  it('shows sort direction toggle', () => {
    const htmlAsc = buildTableHead(
      ['name'],
      { name: 'Name' },
      'name',
      'asc',
      { name: '' },
      [],
    );
    const htmlDesc = buildTableHead(
      ['name'],
      { name: 'Name' },
      'name',
      'desc',
      { name: '' },
      [],
    );
    expect(htmlAsc).toContain('▲');
    expect(htmlDesc).toContain('▼');
  });
});

describe('buildFilterInput', () => {
  it('generates text input by default', () => {
    const html = buildFilterInput('name', 'test', []);
    expect(html).toContain('class="col-filter"');
    expect(html).toContain('data-col="name"');
    expect(html).toContain('value="test"');
    expect(html).toContain('type=');
    expect(html).toContain('text');
  });

  it('forces select type when forceType is "select"', () => {
    const rows = [{ color: 'red' }, { color: 'blue' }];
    const html = buildFilterInput('color', 'red', rows, 'select');
    expect(html).toContain('<select');
    expect(html).toContain('selected');
  });

  it('generates select when unique count below threshold', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ status: i < 5 ? 'active' : 'inactive' }));
    const html = buildFilterInput('status', '', rows, undefined, 40);
    expect(html).toContain('<select');
  });

  it('escapes HTML in column names', () => {
    const html = buildTableHead(
      ['<script>'],
      { '<script>': 'Label' },
      '',
      'asc',
      { '<script>': '' },
      [],
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('buildPagingBar', () => {
  it('generates prev and next buttons', () => {
    const html = buildPagingBar(0, 100, 250);
    expect(html).toContain('id="prev-page"');
    expect(html).toContain('id="next-page"');
  });

  it('disables prev button on first page', () => {
    const html = buildPagingBar(0, 100, 250);
    expect(html).toContain('id="prev-page" disabled');
  });

  it('disables next button on last page', () => {
    const html = buildPagingBar(2, 100, 250);
    expect(html).toContain('id="next-page" disabled');
  });

  it('displays correct info text', () => {
    const html = buildPagingBar(1, 100, 250);
    expect(html).toContain('101–200 of 250');
  });

  it('handles empty results', () => {
    const html = buildPagingBar(0, 100, 0);
    expect(html).toContain('0–0 of 0');
  });
});
