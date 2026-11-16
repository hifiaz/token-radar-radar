// token-radar: the page.
//
// Reads window.RADAR, written beside dashboard/ by main.ts, and renders:
//   - a stat strip (watchlist coverage, rows, pre-token universe, live-token set aside),
//   - a filterable, sortable pre-token board with implied value, confidence band and signal,
//   - a separate Live token tab for protocols whose token already trades,
//   - a detail drawer with the model arithmetic, the band, the signal breakdown and the farm plan.
//
// No network, no framework, no data beyond window.RADAR. Hash routing keeps a view linkable:
//   #p=<slug>  #q=<text>  #c=<category>  #chain=<name>  #min=<tvl>  #t=live  #sort=<key>  #dir=<1|-1>
(function () {
  'use strict';

  var DATA = window.RADAR;
  var app = document.getElementById('board');
  if (!DATA) {
    app.textContent = 'The radar data did not load: data.js is missing beside the dashboard.';
    app.setAttribute('aria-busy', 'false');
    return;
  }

  var state = {
    q: '',
    cat: 'all',
    chain: 'all',
    min: 0,
    tab: 'pre',
    sort: 'rank',
    dir: 1,
    open: null
  };

  var host = null;
  var drawer = null;
  var controls = {};

  // ---------------------------------------------------------------- formatting

  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var abs = Math.abs(n);
    if (abs >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(abs >= 1e8 ? 0 : 1) + 'M';
    if (abs >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }

  var usdFull = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  function moneyFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return usdFull.format(n);
  }

  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }

  function pctArrow(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    if (n > 0.05) return '▲ ' + pct(n);
    if (n < -0.05) return '▼ ' + pct(n);
    return '— ' + pct(n);
  }

  function ageText(days) {
    if (days === null || days === undefined) return '—';
    if (days >= 730) return (days / 365).toFixed(1) + 'y';
    if (days >= 365) return (days / 365).toFixed(2) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  function catName(row) {
    return row.category || 'Uncategorized';
  }

  /** The middle of a list of numbers, or null when the list is empty. */
  function median(values) {
    if (!values.length) return null;
    var sortedValues = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sortedValues.length / 2);
    return sortedValues.length % 2
      ? sortedValues[mid]
      : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
  }

  /**
   * Where a row sits inside the board it answers to: how many rows it outranks, the median implied
   * value of its own DefiLlama category, and the multiple of TVL its number implies. All three come
   * from the board itself, so they change when the model does.
   */
  function placement(row) {
    var peers = DATA.rows.filter(function (other) { return catName(other) === catName(row); });
    var ahead = DATA.rows.filter(function (other) { return other.implied_value_usd > row.implied_value_usd; }).length;
    return {
      ahead: ahead,
      peers: peers.length,
      median: median(peers.map(function (other) { return other.implied_value_usd; })),
      multiple: row.tvl_usd > 0 ? row.implied_value_usd / row.tvl_usd : null
    };
  }

  function placementBlock(row) {
    var spot = placement(row);
    var above = spot.median === null ? null : row.implied_value_usd >= spot.median;
    return el('div', { class: 'placement-wrap' },
      el('div', { class: 'placement' },
        el('span', null, 'Board position', el('b', { text: '#' + (spot.ahead + 1) + ' of ' + DATA.rows.length })),
        el('span', null, catName(row) + ' median (' + spot.peers + ')', el('b', { text: money(spot.median) })),
        el('span', null, 'Implied ÷ TVL', el('b', { text: spot.multiple === null ? '—' : spot.multiple.toFixed(2) + '×' }))
      ),
      above === null ? null : el('p', { class: 'placement-note', text:
        above
          ? 'At or above the median for ' + catName(row) + ': the record is not the category\'s weakest case.'
          : 'Below the median for ' + catName(row) + ': the category carries stronger records in this snapshot.' })
    );
  }

  function chainLine(row, max) {
    var chains = row.chains || [];
    if (chains.length === 0) return 'chain not named';
    var shown = chains.slice(0, max || 3);
    var extra = chains.length - shown.length;
    return shown.join(' · ') + (extra > 0 ? ' +' + extra : '');
  }

  // ---------------------------------------------------------------- DOM helper

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? '' : value);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) {
        child.forEach(function (item) {
          if (item === null || item === undefined || item === false) return;
          node.appendChild(typeof item === 'string' ? document.createTextNode(item) : item);
        });
      } else if (typeof child === 'string') {
        node.appendChild(document.createTextNode(child));
      } else {
        node.appendChild(child);
      }
    }
    return node;
  }

  function signalBar(score) {
    return el('div', { class: 'signal' },
      el('span', { class: 'signal-bar', 'aria-hidden': 'true' },
        el('i', { style: 'width:' + Math.max(2, Math.min(100, score)) + '%' })
      ),
      el('b', { text: String(score) })
    );
  }

  // ---------------------------------------------------------------- hash routing

  function readHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    state.q = params.get('q') || '';
    state.cat = params.get('c') || 'all';
    state.chain = params.get('chain') || 'all';
    state.min = Number(params.get('min')) || 0;
    state.tab = params.get('t') === 'live' ? 'live' : 'pre';
    state.sort = params.get('sort') || (state.tab === 'live' ? 'mcap' : 'rank');
    state.dir = params.get('dir') === '-1' ? -1 : 1;
    state.open = params.get('p') || null;
  }

  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.cat !== 'all') params.set('c', state.cat);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.min > 0) params.set('min', String(state.min));
    if (state.tab === 'live') params.set('t', 'live');
    if (state.sort !== (state.tab === 'live' ? 'mcap' : 'rank')) params.set('sort', state.sort);
    if (state.dir !== 1) params.set('dir', '-1');
    if (state.open) params.set('p', state.open);
    var next = params.toString();
    var url = next ? '#' + next : window.location.pathname + window.location.search;
    window.history.replaceState(null, '', url);
  }

  // ---------------------------------------------------------------- filtering

  function categoryOptions() {
    var seen = {};
    DATA.rows.concat(DATA.live).forEach(function (row) {
      seen[catName(row)] = true;
    });
    return Object.keys(seen).sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
  }

  function chainOptions() {
    var seen = {};
    DATA.rows.concat(DATA.live).forEach(function (row) {
      (row.chains || []).forEach(function (chain) { seen[chain] = true; });
    });
    return Object.keys(seen).sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
  }

  function filtered() {
    var source = state.tab === 'pre' ? DATA.rows : DATA.live;
    var q = state.q.trim().toLowerCase();
    return source.filter(function (row) {
      if (state.cat !== 'all' && catName(row) !== state.cat) return false;
      if (state.chain !== 'all' && (row.chains || []).indexOf(state.chain) < 0) return false;
      if (state.min > 0 && row.tvl_usd < state.min) return false;
      if (!q) return true;
      var hay = [row.name, row.slug, row.category || '', row.symbol || '', (row.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function sortValue(row, key) {
    if (key === 'name') return row.name.toLowerCase();
    if (key === 'category') return catName(row).toLowerCase();
    if (key === 'tvl') return row.tvl_usd;
    if (key === 'growth') return row.change_7d === null || row.change_7d === undefined ? null : row.change_7d;
    if (key === 'age') return row.age_days === null || row.age_days === undefined ? null : row.age_days;
    if (key === 'implied') return row.implied_value_usd;
    if (key === 'signal') return row.signal;
    if (key === 'mcap') return row.mcap_usd === null || row.mcap_usd === undefined ? null : row.mcap_usd;
    if (key === 'symbol') return (row.symbol || '').toLowerCase();
    if (key === 'listed') return row.listed_at || null;
    return row.rank;
  }

  function sorted(rows) {
    var key = state.sort;
    var dir = state.dir;
    return rows.slice().sort(function (a, b) {
      var av = sortValue(a, key);
      var bv = sortValue(b, key);
      if (av === null && bv === null) return a.rank - b.rank;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.rank - b.rank;
    });
  }

  // ---------------------------------------------------------------- shell

  function mark() {
    return el('span', { class: 'mark', 'aria-hidden': 'true' });
  }

  function masthead() {
    return el('header', { class: 'masthead' },
      el('div', { class: 'brand' },
        mark(),
        el('span', { class: 'brand-text' },
          el('b', { text: 'RADAR' }),
          el('span', { text: 'token launch index' })
        )
      ),
      el('div', { class: 'mast-meta' },
        el('span', { class: 'pill amber', text: 'snapshot ' + DATA.as_of }),
        el('span', { class: 'pill cyan', text: 'model ' + DATA.model_version }),
        el('span', { class: 'pill', text: 'defillama index' })
      )
    );
  }

  function hero() {
    return el('section', { class: 'hero' },
      el('div', null,
        el('div', { class: 'eyebrow', text: 'Pre-token protocols · implied value' }),
        el('h1', null, 'Find the launch ', el('em', { text: 'before' }), ' the ticker.'),
        el('p', { class: 'hero-lede' },
          'Every protocol in this snapshot that records no token, ranked by what its own record implies a token could be worth. ' +
          'The board covers all ' + DATA.stats.watchlist_total + ' watchlist protocols and reaches ' + DATA.stats.below_floor + ' protocols below the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor — each row carries a confidence band, a signal score and a numbered farm plan with its cost and time.'
        ),
        el('p', { class: 'model-note' },
          el('b', { text: 'One model, no name list.' }),
          el('span', null, 'Implied value = ', el('code', { text: 'TVL × category multiple × growth × maturity' }), ', all from the snapshot.')
        )
      ),
      el('div', { class: 'stats' },
        stat('Watchlist covered', String(DATA.stats.watchlist_covered) + '/' + String(DATA.stats.watchlist_total), 'slugs in the board', 'green'),
        stat('Ranked rows', String(DATA.stats.board_size), 'pre-token protocols', 'text'),
        stat('Pre-token universe', String(DATA.stats.pre_token_total), 'records with no token', 'text'),
        stat('Live set aside', String(DATA.stats.live_total), 'tokens already trade', 'cyan')
      )
    );
  }

  function stat(label, value, suffix, tone) {
    return el('div', { class: 'stat' },
      el('span', { class: 'stat-label', text: label }),
      el('span', { class: 'stat-value' },
        el('b', { text: value, style: tone === 'green' ? 'color:var(--green)' : tone === 'cyan' ? 'color:var(--cyan)' : null }),
        el('span', { text: suffix })
      )
    );
  }

  function toolbar() {
    var categories = categoryOptions();
    var chains = chainOptions();

    var search = el('input', {
      id: 'q',
      type: 'search',
      placeholder: 'Name, category, chain or slug',
      value: state.q,
      autocomplete: 'off',
      'aria-label': 'Search the board'
    });
    search.addEventListener('input', function () {
      state.q = search.value;
      writeHash();
      renderTable();
    });

    var category = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) {
        return el('option', { value: c, text: c, selected: c === state.cat ? 'selected' : null });
      })
    );
    category.addEventListener('change', function () {
      state.cat = category.value;
      writeHash();
      renderTable();
    });

    var chain = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) {
        return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null });
      })
    );
    chain.addEventListener('change', function () {
      state.chain = chain.value;
      writeHash();
      renderTable();
    });

    var min = el('select', { id: 'min', 'aria-label': 'Minimum TVL' },
      [[0, 'Any TVL'], [10e6, '$10M+'], [25e6, '$25M+'], [50e6, '$50M+'], [100e6, '$100M+'], [250e6, '$250M+'], [1e9, '$1B+'], [5e9, '$5B+']].map(function (pair) {
        return el('option', { value: String(pair[0]), text: pair[1], selected: Number(state.min) === pair[0] ? 'selected' : null });
      })
    );
    min.addEventListener('change', function () {
      state.min = Number(min.value) || 0;
      writeHash();
      renderTable();
    });

    var preTab = el('button', {
      type: 'button',
      'aria-pressed': state.tab === 'pre' ? 'true' : 'false',
      text: 'Pre-token ' + DATA.stats.board_size,
      onclick: function () { switchTab('pre'); }
    });
    var liveTab = el('button', {
      type: 'button',
      'aria-pressed': state.tab === 'live' ? 'true' : 'false',
      text: 'Live token ' + DATA.stats.live_total,
      onclick: function () { switchTab('live'); }
    });

    var clear = el('button', {
      class: 'clear',
      type: 'button',
      text: 'Clear filters',
      onclick: function () {
        state.q = '';
        state.cat = 'all';
        state.chain = 'all';
        state.min = 0;
        syncControls();
        writeHash();
        renderTable();
      }
    });

    controls = { search: search, category: category, chain: chain, min: min, preTab: preTab, liveTab: liveTab };

    return el('section', { class: 'toolbar', 'aria-label': 'Board controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), category),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chain),
      el('div', { class: 'field' }, el('label', { for: 'min', text: 'Min TVL' }), min),
      el('div', { class: 'field' }, el('span', { text: 'Token status' }), el('div', { class: 'tabs' }, preTab, liveTab)),
      el('div', { class: 'toolbar-spacer' }),
      clear
    );
  }

  function switchTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    state.sort = tab === 'live' ? 'mcap' : 'rank';
    state.dir = 1;
    state.open = null;
    if (drawer && drawer.open) drawer.close();
    syncControls();
    writeHash();
    renderTable();
  }

  function syncControls() {
    if (!controls.search) return;
    if (controls.search.value !== state.q) controls.search.value = state.q;
    controls.category.value = state.cat;
    if (controls.category.value !== state.cat) controls.category.value = 'all';
    controls.chain.value = state.chain;
    if (controls.chain.value !== state.chain) controls.chain.value = 'all';
    controls.min.value = String(state.min);
    if (controls.min.value !== String(state.min)) controls.min.value = '0';
    controls.preTab.setAttribute('aria-pressed', state.tab === 'pre' ? 'true' : 'false');
    controls.liveTab.setAttribute('aria-pressed', state.tab === 'live' ? 'true' : 'false');
  }

  // ---------------------------------------------------------------- table

  var PRE_COLUMNS = [
    { key: 'rank', label: 'Rank' },
    { key: 'name', label: 'Protocol' },
    { key: 'category', label: 'Category' },
    { key: 'tvl', label: 'TVL', right: true },
    { key: 'growth', label: '7d', right: true },
    { key: 'age', label: 'Age', right: true },
    { key: 'implied', label: 'Implied value', right: true },
    { key: 'signal', label: 'Signal' }
  ];

  var LIVE_COLUMNS = [
    { key: 'name', label: 'Protocol' },
    { key: 'symbol', label: 'Token' },
    { key: 'category', label: 'Category' },
    { key: 'tvl', label: 'TVL', right: true },
    { key: 'growth', label: '7d', right: true },
    { key: 'mcap', label: 'Market cap', right: true },
    { key: 'listed', label: 'Tracking since', right: true }
  ];

  function headerCell(column) {
    var active = state.sort === column.key;
    var aria = active ? (state.dir === 1 ? 'ascending' : 'descending') : 'none';
    var glyph = active ? (state.dir === 1 ? '▲' : '▼') : '↕';
    return el('th', { scope: 'col', 'aria-sort': aria, class: column.right ? 'r' : null },
      el('button', {
        type: 'button',
        onclick: function () {
          if (state.sort === column.key) {
            state.dir = -state.dir;
          } else {
            state.sort = column.key;
            state.dir = column.key === 'rank' || column.key === 'name' || column.key === 'category' || column.key === 'age' || column.key === 'listed' ? 1 : -1;
          }
          writeHash();
          renderTable();
        }
      },
        column.label,
        el('span', { class: 'sort-glyph', 'aria-hidden': 'true', text: glyph })
      )
    );
  }

  function preRow(row) {
    var growthClass = row.change_7d === null ? 'flat' : row.change_7d > 0.05 ? 'pos' : row.change_7d < -0.05 ? 'neg' : 'flat';
    return el('tr', {
      'data-selected': state.open === row.slug ? 'true' : 'false',
      tabindex: '0',
      'aria-label': 'Open ' + row.name,
      onclick: function () { openDetail(row.slug); },
      onkeydown: function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openDetail(row.slug);
        }
      }
    },
      el('td', { class: 'num' },
        el('span', { class: 'rank' },
          row.watchlist ? el('i', { class: 'wl-dot', title: 'On the house watchlist' }) : null,
          el('b', { text: '#' + row.rank })
        )
      ),
      el('td', null,
        el('div', { class: 'name' },
          el('b', { text: row.name }),
          el('span', { text: chainLine(row, 3) })
        )
      ),
      el('td', null, el('span', { class: 'cat', text: catName(row) })),
      el('td', { class: 'num r', title: moneyFull(row.tvl_usd), text: money(row.tvl_usd) }),
      el('td', { class: 'num r ' + growthClass, text: pctArrow(row.change_7d) }),
      el('td', { class: 'num r', text: ageText(row.age_days) }),
      el('td', { class: 'r' },
        el('div', { class: 'value' },
          el('b', { text: money(row.implied_value_usd) }),
          el('span', { text: money(row.low_usd) + ' – ' + money(row.high_usd) })
        )
      ),
      el('td', null, signalBar(row.signal))
    );
  }

  function liveRow(row) {
    var growthClass = row.change_7d === null ? 'flat' : row.change_7d > 0.05 ? 'pos' : row.change_7d < -0.05 ? 'neg' : 'flat';
    return el('tr', {
      'data-selected': state.open === row.slug ? 'true' : 'false',
      tabindex: '0',
      'aria-label': 'Open ' + row.name,
      onclick: function () { openDetail(row.slug); },
      onkeydown: function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openDetail(row.slug);
        }
      }
    },
      el('td', null,
        el('div', { class: 'name' },
          el('b', { text: row.name }),
          el('span', { text: chainLine(row, 3) })
        )
      ),
      el('td', { class: 'num' }, el('span', { class: 'cat', text: row.symbol || '—' })),
      el('td', null, el('span', { class: 'cat', text: catName(row) })),
      el('td', { class: 'num r', title: moneyFull(row.tvl_usd), text: money(row.tvl_usd) }),
      el('td', { class: 'num r ' + growthClass, text: pctArrow(row.change_7d) }),
      el('td', { class: 'num r', title: moneyFull(row.mcap_usd), text: money(row.mcap_usd) }),
      el('td', { class: 'num r', text: row.listed_at || '—' })
    );
  }

  function emptyState() {
    return el('div', { class: 'empty' },
      el('h2', { text: 'No protocol matches those filters' }),
      el('p', { text: 'Try a shorter search, another category or a lower TVL floor.' }),
      el('button', {
        class: 'button',
        type: 'button',
        text: 'Clear filters',
        onclick: function () {
          state.q = '';
          state.cat = 'all';
          state.chain = 'all';
          state.min = 0;
          syncControls();
          writeHash();
          renderTable();
        }
      })
    );
  }

  function renderTable() {
    if (!host) return;
    var rows = sorted(filtered());
    var columns = state.tab === 'pre' ? PRE_COLUMNS : LIVE_COLUMNS;
    var total = state.tab === 'pre' ? DATA.rows.length : DATA.live.length;

    host.textContent = '';
    if (rows.length === 0) {
      host.appendChild(el('div', { class: 'panel' }, emptyState()));
      return;
    }

    var caption = state.tab === 'pre'
      ? 'Showing ' + rows.length + ' of ' + total + ' pre-token protocols, ranked by implied value. Select a row for the model arithmetic and its farm plan.'
      : 'Token live: these protocols already record a token. Their market cap is a fact from the snapshot, so the ranked board never assigns them an implied value.';

    var table = el('table', null,
      el('caption', { text: caption }),
      el('thead', null, el('tr', null, columns.map(headerCell))),
      el('tbody', null, rows.map(state.tab === 'pre' ? preRow : liveRow))
    );

    host.appendChild(el('div', { class: 'panel' }, el('div', { class: 'table-wrap' }, table)));
  }

  // ---------------------------------------------------------------- detail drawer

  /** The rows the table is showing right now, in their current order. */
  function listForTab() {
    return sorted(filtered());
  }

  /** Move the drawer one row up or down inside the view that is on screen. */
  function stepDetail(delta) {
    var rows = listForTab();
    var at = -1;
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === state.open) at = i;
    var target = rows[at + delta];
    if (target) openDetail(target.slug);
  }

  /**
   * The drawer's own controls: previous and next walk the filtered, sorted board instead of making
   * the reader close the panel and hunt for the row again. Both say what they will open.
   */
  function drawerActions(row) {
    var rows = listForTab();
    var at = -1;
    for (var i = 0; i < rows.length; i++) if (rows[i].slug === row.slug) at = i;
    var before = at > 0 ? rows[at - 1] : null;
    var after = at >= 0 && at < rows.length - 1 ? rows[at + 1] : null;
    return el('div', { class: 'drawer-actions' },
      el('button', {
        class: 'step',
        type: 'button',
        text: '↑',
        title: before ? before.name : 'Top of this view',
        'aria-label': before ? 'Previous row: ' + before.name : 'No row above',
        disabled: before ? null : true,
        onclick: function () { stepDetail(-1); }
      }),
      el('button', {
        class: 'step',
        type: 'button',
        text: '↓',
        title: after ? after.name : 'End of this view',
        'aria-label': after ? 'Next row: ' + after.name : 'No row below',
        disabled: after ? null : true,
        onclick: function () { stepDetail(1); }
      }),
      el('button', { class: 'close', type: 'button', text: 'Close', 'aria-label': 'Close the detail panel', onclick: closeDetail })
    );
  }

  function splitStep(text) {
    var match = /^([\s\S]*?) Budget: ([\s\S]*?)\. Time: ([\s\S]*?)\.$/.exec(text);
    if (!match) return { action: text, budget: '', time: '' };
    return { action: match[1], budget: match[2], time: match[3] };
  }

  function bandBlock(row) {
    return el('div', { class: 'band' },
      el('span', null, 'Low', el('b', { text: money(row.low_usd) })),
      el('span', { class: 'mid' }, 'Implied', el('b', { text: money(row.implied_value_usd) })),
      el('span', null, 'High', el('b', { text: money(row.high_usd) }))
    );
  }

  function preDetail(row) {
    var tier = row.watchlist
      ? el('span', { class: 'pill amber', text: 'watchlist' })
      : row.tvl_usd < DATA.floor_usd
        ? el('span', { class: 'pill cyan', text: 'early · below floor' })
        : el('span', { class: 'pill', text: 'pre-token · off-list' });

    var growth = row.change_7d === null
      ? 'not reported → no growth credit'
      : pct(row.change_7d) + ' → ×' + row.growth_multiplier;

    var steps = row.farm_steps.map(function (text) {
      var step = splitStep(text);
      return el('li', null,
        el('span', { class: 'action', text: step.action }),
        step.budget || step.time
          ? el('span', { class: 'cost' },
            step.budget ? el('span', null, 'Budget ', el('b', { text: step.budget })) : null,
            step.time ? el('span', null, 'Time ', el('b', { text: step.time })) : null
          )
          : null
      );
    });

    return el('div', { class: 'drawer-inner' },
      el('div', { class: 'drawer-head' },
        el('div', null,
          el('div', { class: 'drawer-kicker', text: 'Rank ' + row.rank + ' of ' + DATA.stats.board_size }, tier),
          el('h2', { id: 'drawer-title', text: row.name }),
          el('p', { class: 'drawer-sub', text: catName(row) + ' · ' + chainLine(row, 5) })
        ),
        drawerActions(row)
      ),
      el('div', { class: 'drawer-value' },
        el('div', null,
          el('span', { class: 'big-label', text: 'Implied value' }),
          el('div', { class: 'big-number', text: moneyFull(row.implied_value_usd) })
        ),
        bandBlock(row)
      ),
      el('h3', { text: 'The arithmetic' }),
      el('div', { class: 'equation' },
        eqRow('TVL', moneyFull(row.tvl_usd)),
        eqRow('Category multiple', catName(row) + ' × ' + row.multiple),
        eqRow('Base', moneyFull(row.base_usd)),
        eqRow('Seven-day growth', growth),
        eqRow('Age on record', ageText(row.age_days) + ' → maturity ×' + row.maturity_multiplier),
        eqRow('Band', '±' + Math.round(row.confidence * 1000) / 10 + '%')
      ),
      el('p', { class: 'drawer-sub', text: 'The same function scores every protocol; no name is special-cased. The band widens for young protocols and a missing seven-day figure.' }),
      placementBlock(row),
      el('h3', { text: 'Farm plan · ' + row.farm_steps.length + ' steps' }),
      el('ol', { class: 'plan' }, steps),
      el('h3', { text: 'Signal ' + row.signal + ' / 100' }),
      el('div', { class: 'signal-detail' },
        sigRow('Age', row.signal_age, 40),
        sigRow('TVL', row.signal_tvl, 35),
        sigRow('Growth', row.signal_growth, 25),
        el('div', { class: 'sig-total' }, el('span', { text: 'Total signal' }), el('b', { text: String(row.signal) }))
      ),
      el('div', { class: 'provenance' },
        el('b', { text: 'DefiLlama record' }),
        ', fetched ' + DATA.as_of + '; this protocol records no token. ',
        'Implied value is this radar\'s model reading of the record, not a price and not a promise of a launch. ',
        'Lineage: ' + DATA.source.replace(/^DefiLlama\s+/, '') + '.'
      )
    );
  }

  function eqRow(label, value) {
    return el('div', null, el('span', { text: label }), el('b', { text: value }));
  }

  function sigRow(label, points, max) {
    return el('div', { class: 'sig-row' },
      el('span', { text: label }),
      el('span', { class: 'sig-track', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(1, Math.min(100, (points / max) * 100)) + '%' })),
      el('b', { text: points + ' / ' + max })
    );
  }

  function liveDetail(row) {
    var ratio = row.mcap_usd && row.tvl_usd ? (row.mcap_usd / row.tvl_usd).toFixed(2) + '×' : '—';
    return el('div', { class: 'drawer-inner' },
      el('div', { class: 'drawer-head' },
        el('div', null,
          el('div', { class: 'drawer-kicker', text: 'Token live · set aside' }),
          el('h2', { id: 'drawer-title', text: row.name }),
          el('p', { class: 'drawer-sub', text: catName(row) + ' · ' + chainLine(row, 5) })
        ),
        drawerActions(row)
      ),
      el('div', { class: 'drawer-value' },
        el('div', null,
          el('span', { class: 'big-label', text: 'Market cap' }),
          el('div', { class: 'big-number', text: moneyFull(row.mcap_usd) })
        ),
        el('div', { class: 'band' },
          el('span', null, 'TVL', el('b', { text: money(row.tvl_usd) })),
          el('span', null, 'MC / TVL', el('b', { text: ratio })),
          el('span', null, '7d', el('b', { text: pct(row.change_7d) }))
        )
      ),
      el('h3', { text: 'The record' }),
      el('div', { class: 'equation' },
        eqRow('Token symbol', row.symbol || 'not reported'),
        eqRow('Market cap', moneyFull(row.mcap_usd)),
        eqRow('TVL', moneyFull(row.tvl_usd)),
        eqRow('Seven-day TVL change', pct(row.change_7d)),
        eqRow('DefiLlama tracking since', row.listed_at || 'not reported')
      ),
      el('div', { class: 'live-note' },
        el('b', { text: 'Why it is not ranked. ' }),
        'This protocol records a token, so it never enters the pre-token board and no implied value is claimed for it. Its market cap is DefiLlama\'s own figure from the same snapshot, shown for comparison only.'
      ),
      el('div', { class: 'provenance' },
        el('b', { text: 'DefiLlama record' }),
        ', fetched ' + DATA.as_of + '; the protocol records a token. Live-token protocols are kept in their own tab so a market value is never confused with the model\'s value.'
      )
    );
  }

  function ensureDrawer() {
    if (drawer) return drawer;
    drawer = el('dialog', { class: 'drawer', id: 'detail', 'aria-labelledby': 'drawer-title' });
    drawer.addEventListener('close', function () {
      if (state.open) {
        state.open = null;
        writeHash();
        renderTable();
      }
    });
    drawer.addEventListener('click', function (event) {
      if (event.target === drawer) closeDetail();
    });
    document.body.appendChild(drawer);
    return drawer;
  }

  function openDetail(slug) {
    var pre = DATA.rows.filter(function (row) { return row.slug === slug; })[0];
    var live = DATA.live.filter(function (row) { return row.slug === slug; })[0];
    var row = pre || live;
    if (!row) return;

    state.open = slug;
    writeHash();
    renderTable();

    var dialog = ensureDrawer();
    dialog.textContent = '';
    dialog.appendChild(pre ? preDetail(pre) : liveDetail(live));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    var close = dialog.querySelector('.close');
    if (close) close.focus();
  }

  function closeDetail() {
    if (!drawer) return;
    if (typeof drawer.close === 'function' && drawer.open) drawer.close();
    else drawer.removeAttribute('open');
    state.open = null;
    writeHash();
    renderTable();
  }

  // ---------------------------------------------------------------- method

  function method() {
    var m = DATA.model;
    return el('section', { class: 'method', 'aria-label': 'Method' },
      el('div', { class: 'card' },
        el('h2', { text: 'How a row gets its number' }),
        el('p', { text: 'One function reads four snapshot figures: TVL, the category multiple, the seven-day TVL change and the days since DefiLlama began tracking the protocol. Nothing else — no name list, no hand-picked row, no outside data.' }),
        el('pre', { class: 'formula' },
          'implied = max(1, round(\n' +
          '  tvl_usd × multiple(category)\n' +
          '  × (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 × ' + m.growth_weight + ')\n' +
          '  × (' + m.maturity_floor.toFixed(2) + ' + ' + m.maturity_range.toFixed(2) + ' × min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ')\n' +
          '))'
        ),
        el('div', { class: 'notes' },
          el('div', { class: 'note' }, el('b', { text: 'Derived, not listed' }), 'The category table below is the only hand-set input; every row then goes through the same arithmetic.'),
          el('div', { class: 'note' }, el('b', { text: 'Live kept apart' }), DATA.stats.live_total + ' protocols record a token and sit in their own tab with their market cap, never in this ranking.'),
          el('div', { class: 'note' }, el('b', { text: 'A band, not a promise' }), 'The low–high range widens for young protocols and when the seven-day change is missing.')
        ),
        el('h3', { text: 'Confidence band' }),
        el('p', null,
          'u = ' + m.band_base + ' + ' + m.band_youth + ' × (1 − min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ') + ' + m.band_missing_growth + ' when the seven-day change is absent. ',
          'Low = round(implied × (1 − u)); high = round(implied × (1 + u)). An unlisted protocol is modelled at ' + m.unknown_age_days + ' days.'
        ),
        el('h3', { text: 'Signal score' }),
        el('p', null,
          '0–100, independent of the value: sign(40) × age share + sign(35) × log TVL share between $5M and $5B + sign(25) × clamped seven-day growth. ',
          'It says how much evidence the record carries; implied value says what the record would support.'
        ),
        el('h3', { text: 'Which rows are on the board' }),
        el('p', null,
          DATA.stats.watchlist_covered + ' of ' + DATA.stats.watchlist_total + ' watchlist protocols, then every pre-token protocol below the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor (' + DATA.stats.below_floor + ' rows), then every credible off-list pre-token protocol above the floor (' + DATA.stats.off_list + ' rows) — never an exchange, a versioned pool, or a wrapped, staked or bridged product — for ' + DATA.stats.board_size + ' rows in all. The watchlist is the floor, not the ceiling.'
        )
      ),
      el('aside', { class: 'card' },
        el('h2', { text: 'Category multiples' }),
        el('p', { text: 'TVL is discounted by what a category tends to keep in a token. DefiLlama categories, never protocol names.' }),
        el('dl', { class: 'mult-list' },
          DATA.category_multiples.map(function (pair) {
            return el('div', null, el('dt', { text: pair[0] }), el('dd', { text: pair[1].toFixed(2) }));
          })
        ),
        el('p', { class: 'drawer-sub', text: 'Every other category, an uncategorised record included: 0.25.' })
      )
    );
  }

  function footer() {
    return el('footer', { class: 'foot' },
      el('span', null,
        'Source: ',
        el('b', { text: 'DefiLlama protocol index' }),
        ' · snapshot ' + DATA.as_of + ' · ' + DATA.source + '. Rendered offline from data.js written by main.ts.'
      ),
      el('span', { text: 'Implied values are this entry\'s model claim, not make.fun\'s, not a price, and not a prediction that a token launches.' })
    );
  }

  // ---------------------------------------------------------------- boot

  function buildShell() {
    app.textContent = '';
    app.appendChild(masthead());
    app.appendChild(hero());
    app.appendChild(toolbar());
    host = el('div', { id: 'table-host' });
    app.appendChild(host);
    app.appendChild(method());
    app.appendChild(footer());
    app.setAttribute('aria-busy', 'false');
  }

  readHash();
  buildShell();
  renderTable();

  if (state.open) {
    var first = state.open;
    openDetail(first);
  }

  window.addEventListener('hashchange', function () {
    var previous = state.open;
    readHash();
    syncControls();
    renderTable();
    if (state.open && state.open !== previous) openDetail(state.open);
    if (!state.open && drawer && drawer.open) drawer.close();
  });
})();
