/**
 * Shared checkbox filter group used by platform and project filter panels.
 *
 * The returned group's markup uses the shared sessions-filter CSS classes so
 * spacing and appearance stay consistent across pages.
 */

/**
 * Build a titled checkbox group.
 *
 * @param {string} title
 * @param {string[]} options
 * @param {Set<string>} selectedSet
 * @param {() => void} [onChange]
 * @returns {{ wrapper: HTMLElement, renderOptions: (options: string[]) => void }}
 */
export function buildCheckboxGroup(title, options, selectedSet, onChange = () => {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'sessions-filter-group';

  const labelEl = document.createElement('div');
  labelEl.className = 'sessions-filter-label';
  labelEl.textContent = title;
  wrapper.appendChild(labelEl);

  const list = document.createElement('div');
  list.className = 'sessions-checkbox-list';
  wrapper.appendChild(list);

  function renderOptions(nextOptions) {
    const values = (nextOptions ?? []).map((option) => String(option));
    for (const value of [...selectedSet]) {
      if (!values.includes(value)) selectedSet.delete(value);
    }

    list.innerHTML = '';
    if (values.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'sessions-filter-empty';
      empty.textContent = 'No options';
      list.appendChild(empty);
      return;
    }

    for (const value of values) {
      const item = document.createElement('label');
      item.className = 'sessions-checkbox-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = value;
      checkbox.checked = selectedSet.has(value);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedSet.add(value);
        else selectedSet.delete(value);
        onChange();
      });
      item.appendChild(checkbox);

      const text = document.createElement('span');
      text.textContent = value;
      item.appendChild(text);
      list.appendChild(item);
    }
  }

  const clearBtn = document.createElement('button');
  clearBtn.className = 'sessions-filter-clear';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', () => {
    selectedSet.clear();
    list.querySelectorAll('input[type=checkbox]').forEach((checkbox) => {
      checkbox.checked = false;
    });
    onChange();
  });
  wrapper.appendChild(clearBtn);

  renderOptions(options);
  return { wrapper, renderOptions };
}
