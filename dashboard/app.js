// Token Radar (radar-4) dashboard. It reads window.RADAR (written beside
// dashboard/ by main.ts) and renders the ranked board, a filterable table, a
// per-protocol detail view with the model's own inputs, its live-token peers
// and the protocol's farm plan. No network: every byte it shows is in data.js.
//
// The model in one function: the page recomputes a row from the snapshot
// figures and checks the number board.json carries, so the page's code and
// the board's data are visibly the same arithmetic. Implied value is
// TVL x category multiple x growth x maturity x breadth, where the category
// multiple is the winsorized median market-cap-to-TVL ratio of the live-token
// protocols in that category, shrunk toward the global median by
// (n x base + 3 x global) / (n + 3). The base is the category's own median
// when it has at least 3 comparables; below that, the pooled median of its
// whole family of near categories, so one peer can no longer set a
// category's multiple on its own. The detail view shows the derivation:
// which peers, which median, and the shrink, in numbers.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', minTvl: 0, watchOnly: false, tab: 'pre-token', sort: 'implied', dir: -1, selected: null, liveSort: { key: 'mcap', dir: -1 } };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return 'x' + Number(n).toFixed(2); }

  // The model, recomputed in the page from the same figures main.ts used.
  function impliedOf(row, model) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    var breadth = 1 + Math.min(Math.max((row.chains || []).length - 1, 0), model.breadth_max_chains) * model.breadth_step;
    return Math.max(1, Math.round(row.tvl_usd * row.category_multiple * growthMult * maturity * breadth));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The farm plan is the same derivation main.ts writes to board.json:
  // category, chains, TVL and age decide the action, the capital, the hold
  // and every cost and time. No name is special-cased, and no two categories
  // farm alike: the weekly action, the claim surface, the reason to hold
  // and the log all follow the protocol's own category, and the gas note
  // follows its main chain.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function farmFamily(p) {
    var c = (p.category || '').toLowerCase();
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0 || c.indexOf('uncollateralized') >= 0) return 'lending';
    if (c.indexOf('dex') >= 0) return 'dex';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('farm') >= 0 || c.indexOf('liquidity manager') >= 0 || c.indexOf('index') >= 0 || c.indexOf('options vault') >= 0) return 'vault';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'staking';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('basis') >= 0 || c.indexOf('option') >= 0 || c.indexOf('synthetic') >= 0 || c.indexOf('interest rate') >= 0) return 'perps';
    if (c.indexOf('prediction') >= 0) return 'prediction';
    if (c.indexOf('stable') >= 0) return 'stable';
    if (c.indexOf('rwa') >= 0) return 'rwa';
    if (c.indexOf('bridge') >= 0) return 'bridge';
    if (c.indexOf('insurance') >= 0) return 'insurance';
    if (c.indexOf('chain') >= 0) return 'chain';
    if (c.indexOf('payment') >= 0 || c.indexOf('card issuer') >= 0) return 'payments';
    if (c.indexOf('btc') >= 0 || c.indexOf('anchor') >= 0) return 'btc';
    if (c.indexOf('governance') >= 0) return 'governance';
    if (c.indexOf('cedefi') >= 0) return 'cedefi';
    return 'generic';
  }
  var FARM_WEEKLY = {
    lending: function (name) { return 'Supply or borrow a small amount on ' + name + ' each week so the position shows fresh activity.'; },
    dex: function (name) { return 'Swap a small amount through ' + name + "'s main pool each week and leave the liquidity in place."; },
    vault: function (name) { return 'Harvest ' + name + "'s yield each week and re-deposit it so the position compounds."; },
    staking: function (name) { return 'Restake the staking rewards on ' + name + ' each week instead of letting them sit idle.'; },
    perps: function (name) { return 'Open and close one small hedge on ' + name + ' each week so the account stays active.'; },
    prediction: function (name) { return 'Place or settle one small market position on ' + name + ' each week.'; },
    stable: function (name) { return 'Mint or redeem a small amount of the stable asset through ' + name + ' each week.'; },
    rwa: function (name) { return "Check the yield asset's accrual on " + name + ' each week and top it up with a small mint.'; },
    bridge: function (name) { return 'Bridge a small amount through ' + name + ' each week, alternating direction.'; },
    insurance: function (name) { return 'Review the cover on ' + name + ' each week and renew or top it up before it lapses.'; },
    chain: function (name) { return 'Use ' + name + "'s apps each week so the wallet shows activity beyond the bridge."; },
    payments: function (name) { return 'Route one small payment through ' + name + ' each week.'; },
    btc: function (name) { return 'Top up the BTC position on ' + name + ' with a small amount each week.'; },
    governance: function (name) { return 'Vote on one proposal on ' + name + ' each week while the position is open.'; },
    cedefi: function (name) { return 'Move a small amount through ' + name + ' each week.'; },
    generic: function (name) { return 'Make one qualifying action on ' + name + ' each week, such as a deposit, a borrow, a swap or a vote.'; }
  };
  var FARM_CLAIM = {
    lending: function (name) { return 'open the rewards tab on ' + name + "'s lending app"; },
    dex: function (name) { return 'open ' + name + "'s rewards or fee-share page"; },
    vault: function (name) { return 'open ' + name + "'s vault rewards tab"; },
    staking: function (name) { return 'open ' + name + "'s staking rewards page"; },
    perps: function (name) { return 'open ' + name + "'s trading rewards page"; },
    prediction: function (name) { return 'open ' + name + "'s market rewards or points page"; },
    stable: function (name) { return "open the stable asset's rewards page on " + name; },
    rwa: function (name) { return 'open ' + name + "'s yield-asset rewards tab"; },
    bridge: function (name) { return 'open ' + name + "'s points page"; },
    insurance: function (name) { return 'open the policy page on ' + name; },
    chain: function (name) { return 'open ' + name + "'s points or rewards page"; },
    payments: function (name) { return 'open ' + name + "'s rewards page"; },
    btc: function (name) { return 'open ' + name + "'s rewards tab"; },
    governance: function (name) { return 'open ' + name + "'s governance page"; },
    cedefi: function (name) { return 'open ' + name + "'s rewards page"; },
    generic: function (name) { return 'open ' + name + "'s own points or rewards page"; }
  };
  var FARM_HOLD = {
    lending: 'so the borrow history spans more than one snapshot',
    dex: 'so the pool position ages past the first snapshot',
    vault: 'so the vault’s snapshots count the position',
    staking: 'so the stake ages past the first snapshot',
    perps: 'so the trading history spans more than one snapshot',
    prediction: 'so the market activity spans more than one snapshot',
    stable: 'so the mint ages past the first snapshot',
    rwa: 'so the holding ages past the first snapshot',
    bridge: 'so the bridge volume spans more than one snapshot',
    insurance: 'so the policy covers more than one snapshot',
    chain: 'so the wallet activity spans more than one snapshot',
    payments: 'so the payment history spans more than one snapshot',
    btc: 'so the position ages past the first snapshot',
    governance: 'so the votes span more than one snapshot',
    cedefi: 'so the activity spans more than one snapshot',
    generic: 'so the activity is counted in more than one snapshot'
  };
  var FARM_LOG = {
    lending: 'Note the supplied amount and each borrow.',
    dex: 'Note the pool and the price range.',
    vault: 'Note the vault shares and each harvest.',
    staking: 'Note the staked amount and each restake.',
    perps: 'Note the margin and the position size.',
    prediction: 'Note each market and its outcome.',
    stable: 'Note each mint and redemption.',
    rwa: 'Note the yield-asset balance.',
    bridge: 'Note each bridge direction and amount.',
    insurance: 'Note the policy number and expiry.',
    chain: 'Note each app you used.',
    payments: 'Note each payment’s recipient.',
    btc: 'Note each top-up.',
    governance: 'Note each vote.',
    cedefi: 'Note each transfer.',
    generic: ''
  };
  function gasNoteFor(chain) {
    if (chain === 'Solana') return { note: 'Solana fees are under $0.01 a transaction, so a $2 SOL buffer covers months of activity.', cost: 'under $0.01 of gas for the first transaction', weeklyCost: 'under $0.10 of gas a week' };
    if (chain === 'Ethereum') return { note: 'Ethereum gas is the dearest here, so keep $10 of ETH aside for fees.', cost: '$10 of ETH for gas', weeklyCost: 'about $5 of gas a week' };
    if (['Arbitrum', 'Optimism', 'Base', 'Linea', 'Unichain', 'Blast', 'Mode', 'Scroll', 'Zora', 'Ink', 'Soneium', 'World Chain'].indexOf(chain) >= 0) {
      return { note: 'Keep $5 of ETH on ' + chain + ' for gas.', cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
    }
    if (chain === 'Binance') return { note: 'Keep a few dollars of BNB on ' + chain + ' for gas.', cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
    if (chain === 'Avalanche') return { note: 'Keep a few dollars of AVAX on ' + chain + ' for gas.', cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
    if (chain === 'Polygon') return { note: 'Keep a few dollars of POL on ' + chain + ' for gas.', cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
    if (chain === 'Tron') return { note: 'Keep a few dollars of TRX on ' + chain + ' for bandwidth and energy.', cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
    if (chain === 'Hyperliquid L1') return { note: 'Keep a few dollars of HYPE on ' + chain + ' for gas.', cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
    if (chain === 'Monad') return { note: 'Keep a few dollars of MON on ' + chain + ' for gas.', cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
    if (chain === 'Plasma') return { note: 'Keep a few dollars of XPL on ' + chain + ' for gas.', cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
    if (chain === 'Sui') return { note: 'Keep a few dollars of SUI on ' + chain + ' for gas.', cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
    if (chain === 'Aptos') return { note: 'Keep a few dollars of APT on ' + chain + ' for gas.', cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
    if (chain === 'Near') return { note: 'Keep a few dollars of NEAR on ' + chain + ' for gas.', cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
    if (chain === 'Bitcoin') return { note: 'Keep a small BTC buffer for network fees.', cost: 'a small BTC fee for the first transaction', weeklyCost: 'about $2 of fees a week' };
    return { note: 'Keep a small gas buffer on ' + chain + '.', cost: 'a few dollars of gas for the first transaction', weeklyCost: 'about $2 of gas a week' };
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    if (c.indexOf('basis') >= 0) return 'Open a $' + capital + ' basis trade on ' + name + ' on ' + chain + ' and hold both legs.';
    if (c.indexOf('option') >= 0) return 'Deposit $' + capital + ' into an ' + name + ' options vault on ' + chain + ' and keep the position open.';
    if (c.indexOf('launchpad') >= 0) return "Complete " + name + "'s eligibility tasks on " + chain + ' with $' + capital + ' staked.';
    if (c.indexOf('payment') >= 0 || c.indexOf('card issuer') >= 0) return 'Route $' + capital + ' of payments through ' + name + ' on ' + chain + '.';
    if (c.indexOf('index') >= 0) return 'Buy $' + capital + ' of the ' + name + ' index on ' + chain + ' and hold it.';
    if (c.indexOf('locker') >= 0) return 'Lock $' + capital + ' of tokens in ' + name + ' on ' + chain + ' for the longest term you accept.';
    if (c.indexOf('liquidity') >= 0) return 'Deposit $' + capital + " into " + name + "'s managed liquidity position on " + chain + '.';
    if (c.indexOf('farm') >= 0) return 'Stake $' + capital + ' of LP tokens in the ' + name + ' farm on ' + chain + '.';
    if (c.indexOf('chain') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + " and use it across the chain's apps.";
    if (c.indexOf('btc') >= 0 || c.indexOf('anchor') >= 0) return 'Deposit $' + capital + ' of BTC into ' + name + ' on ' + chain + ' and keep the receipt.';
    if (c.indexOf('governance') >= 0) return 'Lock $' + capital + ' of governance tokens with ' + name + ' on ' + chain + ' and vote.';
    if (c.indexOf('privacy') >= 0) return 'Deposit $' + capital + " into " + name + "'s private pool on " + chain + '.';
    if (c.indexOf('ai agent') >= 0 || c.indexOf('decentralized ai') >= 0) return 'Fund $' + capital + ' into an ' + name + ' agent on ' + chain + ' and keep it running.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function holdReason(p) {
    var age = p.age_days;
    var agePart;
    if (age === null || age === undefined) agePart = 'Its listing date is unknown, so hold the full term instead of guessing when the snapshots fall.';
    else if (age < 180) agePart = 'It listed recently, so this hold covers its first full snapshots.';
    else if (age < 365) agePart = 'It has run most of a year with no token, so the hold spans the snapshots that follow.';
    else agePart = 'It has run over a year with no token, so the hold is about staying in through the next snapshots.';
    var tvlPart;
    if (p.tvl_usd >= 1e9) tvlPart = 'At this size it is one of the largest pre-token protocols, so a missed snapshot costs the most.';
    else if (p.tvl_usd >= 1e8) tvlPart = 'At this size the position is worth the full hold.';
    else tvlPart = 'A smaller protocol\u2019s snapshots count the most, so do not pull the position early.';
    return agePart + ' ' + tvlPart;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var family = farmFamily(p);
    var gas = gasNoteFor(chain);
    var logNote = FARM_LOG[family];
    return [
      { text: 'Use a fresh wallet to farm ' + p.name + ' on ' + chain + ', funded with $' + capital + ' plus gas, and keep its seed phrase offline. ' + gas.note, cost: gas.cost, time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
      { text: FARM_WEEKLY[family](p.name), cost: gas.weeklyCost, time: '10 minutes a week' },
      { text: 'Hold the ' + p.name + ' position for at least ' + hold + ' days, ' + FARM_HOLD[family] + '. ' + holdReason(p), cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: 'Before you withdraw, ' + FARM_CLAIM[family](p.name) + ' and claim only from the link it publishes.', cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction on ' + p.name + ' in a farm log so you can repeat the position or unwind it.' + (logNote === '' ? '' : ' ' + logNote), cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  // The family a category pools with when it has too few comparables of its
  // own: the near categories that trade the same way. Same map as main.ts,
  // so the page and the board agree on which peers set a multiple.
  function multipleFamily(category) {
    var c = (category || '').toLowerCase();
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0 || c.indexOf('uncollateralized') >= 0) return 'lending';
    if (c.indexOf('synthetic') >= 0 || c.indexOf('interest rate') >= 0) return 'synthetics';
    if (c.indexOf('yield') >= 0 || c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('liquidity manager') >= 0 || c.indexOf('farm') >= 0 || c.indexOf('index') >= 0 || c.indexOf('options vault') >= 0 || c.indexOf('locker') >= 0) return 'yield';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'staking';
    if (c.indexOf('stable') >= 0) return 'stable';
    if (c.indexOf('bridge') >= 0) return 'bridge';
    if (c.indexOf('dex') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('basis') >= 0 || c.indexOf('option') >= 0 || c.indexOf('prediction') >= 0 || c.indexOf('dor') >= 0) return 'trading';
    if (c.indexOf('rwa') >= 0 || c.indexOf('reserve currency') >= 0) return 'rwa';
    if (c.indexOf('payment') >= 0 || c.indexOf('card issuer') >= 0) return 'payments';
    if (c.indexOf('insurance') >= 0) return 'insurance';
    if (c.indexOf('btc') >= 0 || c.indexOf('anchor') >= 0) return 'btc';
    if (c.indexOf('decentralized ai') >= 0 || c.indexOf('ai agent') >= 0) return 'ai';
    if (c.indexOf('nft') >= 0) return 'nft';
    if (c.indexOf('launchpad') >= 0) return 'launchpad';
    if (c.indexOf('governance') >= 0) return 'governance';
    if (c.indexOf('cedefi') >= 0) return 'cedefi';
    if (c.indexOf('otc') >= 0) return 'otc';
    if (c.indexOf('chain') >= 0) return 'chain';
    return 'generic';
  }
  // The categories in a row's family, for the derivation note.
  function familyCategories(row) {
    var fam = row.multiple_family || multipleFamily(row.category);
    var cats = [];
    DATA.comparables.forEach(function (c) { if (multipleFamily(c.category) === fam && cats.indexOf(c.category) < 0) cats.push(c.category); });
    return cats;
  }

  // Live-token peers behind the multiple: the same category when it has
  // enough comparables of its own, the whole family when it pooled.
  // Drawn from the full comparables set main.ts ships (every live-token
  // protocol with a market cap), so the peer that justifies a multiple is
  // shown even when it is not one of the top 24 on the Live tab.
  function peersOf(row) {
    var pool = DATA.peers && DATA.peers.length ? DATA.peers : DATA.live;
    var fam = row.multiple_family || multipleFamily(row.category);
    var source = row.multiple_source || 'category';
    var list = pool.filter(function (l) { return source === 'family' ? multipleFamily(l.category) === fam : l.category === row.category; })
      .sort(function (a, b) { return (b.mcap_usd || 0) - (a.mcap_usd || 0); })
      .slice(0, 4);
    return list;
  }
  function comparableOf(category) {
    var found = null;
    DATA.comparables.forEach(function (c) { if (c.category === category) found = c; });
    return found;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('watch') === '1') state.watchOnly = true;
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.watchOnly) params.set('watch', '1');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watchOnly && !r.watchlist) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.minTvl > 0 && r.tvl_usd < state.minTvl) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'multiple') { av = a.category_multiple; bv = b.category_multiple; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function lede() {
    var top = DATA.rows[0];
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor, filtered by the same rule. Implied value is a model, not a promise.' }),
        el('div', { class: 'spot' },
          el('span', { class: 'chip' }, 'Top pick ', el('b', { text: top ? top.name : 'n/a' })),
          el('span', { class: 'chip' }, 'Implied ', el('b', { text: top ? fmtUsd(top.implied_value_usd) : 'n/a' })),
          el('span', { class: 'chip' }, 'Global multiple ', el('b', { text: fmtMult(DATA.global_multiple) }))
        )
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSelect = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    catSelect.addEventListener('change', function () { state.category = catSelect.value; writeHash(); render(); });
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; writeHash(); render(); });
    var tvlSelect = el('select', { id: 'minTvl', 'aria-label': 'Minimum TVL' },
      el('option', { value: '0', text: 'Any TVL' }),
      el('option', { value: '50000000', text: 'TVL $50M and up' }),
      el('option', { value: '100000000', text: 'TVL $100M and up' }),
      el('option', { value: '500000000', text: 'TVL $500M and up' })
    );
    tvlSelect.addEventListener('change', function () { state.minTvl = Number(tvlSelect.value); render(); });
    var watchBtn = el('button', { type: 'button', 'aria-pressed': state.watchOnly ? 'true' : 'false', text: state.watchOnly ? 'Watchlist only: on' : 'Watchlist only', onclick: function () { state.watchOnly = !state.watchOnly; writeHash(); render(); } });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field grow' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSelect),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('label', { for: 'minTvl', text: 'TVL floor' }), tvlSelect),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Scope' }), watchBtn),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' of ' + DATA.board_size + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.minTvl = 0; state.watchOnly = false; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') + (r.watchlist ? ' - watchlist' : '') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtMult(r.category_multiple) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status pre', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model, its peers and its farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('multiple', 'Multiple'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveSortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.liveSort.key === key) state.liveSort.dir = -state.liveSort.dir; else { state.liveSort.key = key; state.liveSort.dir = -1; } render(); } },
        label,
        state.liveSort.key === key ? el('span', { 'aria-hidden': 'true', text: state.liveSort.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function liveTable() {
    var list = DATA.live.slice().sort(function (a, b) {
      var av, bv;
      if (state.liveSort.key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (state.liveSort.key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (state.liveSort.key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (state.liveSort.key === 'ratio') { av = a.mcap_usd && a.tvl_usd ? a.mcap_usd / a.tvl_usd : -Infinity; bv = b.mcap_usd && b.tvl_usd ? b.mcap_usd / b.tvl_usd : -Infinity; }
      else { av = a.mcap_usd || 0; bv = b.mcap_usd || 0; }
      if (av < bv) return -state.liveSort.dir;
      if (av > bv) return state.liveSort.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
    var tbody = el('tbody');
    list.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.mcap_usd && r.tvl_usd ? fmtMult(r.mcap_usd / r.tvl_usd) : 'n/a' }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking, and their market-cap-to-TVL ratios are the comparables the model prices the board with.' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Status' }),
            liveSortHeader('name', 'Protocol'),
            liveSortHeader('tvl', 'TVL'),
            liveSortHeader('growth', '7d'),
            liveSortHeader('mcap', 'Market cap'),
            liveSortHeader('ratio', 'Mcap / TVL'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var topCats = DATA.comparables.filter(function (c) { return c.n >= 3; }).slice(0, 6);
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked. The multiple is the market talking: what live-token protocols in the same category are actually worth per dollar of TVL.' }),
      el('div', { class: 'formula' },
        'implied = round( tvl_usd x category multiple x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') x (1 + min(chains - 1, ' + m.breadth_max_chains + ') x ' + m.breadth_step + ') )'
      ),
      el('div', { class: 'model-grid' },
        el('div', { class: 'model-cell' }, el('span', { text: 'Global multiple' }), el('b', { text: fmtMult(DATA.global_multiple) + ' (median of ' + DATA.comparable_count + ' live-token protocols with a market cap)' })),
        el('div', { class: 'model-cell' }, el('span', { text: 'Multiple range' }), el('b', { text: fmtMult(m.multiple_floor) + ' to ' + fmtMult(m.multiple_cap) })),
        el('div', { class: 'model-cell' }, el('span', { text: 'Growth weight' }), el('b', { text: String(m.growth_weight) + ', clamped ' + m.growth_floor + '% to +' + m.growth_cap + '%' })),
        el('div', { class: 'model-cell' }, el('span', { text: 'Age' }), el('b', { text: 'listed date to ' + DATA.as_of + '; unknown uses ' + m.unknown_age_days + 'd' }))
      ),
      el('p', { class: 'sub', text: 'Effective category multiples, each category\u2019s median pulled toward the global median when it has few comparables: ' + topCats.map(function (c) { return c.category + ' ' + fmtMult(c.effective_multiple) + ' (n=' + c.n + ')'; }).join(', ') + '. A category with fewer than ' + m.thin_category_n + ' comparables pools its family of near categories instead of standing on one peer: multiple = (n x family median + ' + m.shrink_prior + ' x global median) / (n + ' + m.shrink_prior + '), over ratios winsorized to 0.05-1.00, so one wild comparable cannot set the multiple. The detail view shows the derivation for every row.' }),
      el('p', { class: 'sub', text: 'Age is the time since the protocol was first listed, the best record of how long it has run with no token. The early radar applies the watchlist rule below the floor: no bridge, liquid staking or restaking product, no versioned pool, no wrapped or staked product, no exchange-branded name.' }),
      el('div', { class: 'note', text: 'Say it plainly: a protocol records no token, never that it has none. A token may already exist that the snapshot does not carry, and no row here predicts whether or when a token launches. Implied value is this model\u2019s claim, not a price, and farming never guarantees an airdrop.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
    var peers = peersOf(row);
    var comp = comparableOf(row.category);
    var source = row.multiple_source || 'category';
    var shrink = DATA.model.shrink_prior;
    var multipleNote;
    if (source === 'global') multipleNote = 'No live-token peer in this category or its ' + (row.multiple_family || multipleFamily(row.category)) + ' family, so the multiple is the global median ' + fmtMult(DATA.global_multiple) + ' (median of ' + DATA.comparable_count + ' live-token protocols with a market cap).';
    else if (source === 'family') multipleNote = 'Only ' + row.comparables_n + ' live-token peer' + (row.comparables_n === 1 ? '' : 's') + ' in ' + (row.category || 'this category') + ', so the multiple pools the ' + row.multiple_family + ' family (' + familyCategories(row).length + ' categories, n=' + row.multiple_family_n + ' peers): family median ' + fmtMult(row.multiple_family_median) + ', shrunk toward the global median ' + fmtMult(DATA.global_multiple) + ': (' + row.multiple_family_n + ' x ' + fmtMult(row.multiple_family_median) + ' + ' + shrink + ' x ' + fmtMult(DATA.global_multiple) + ') / (' + row.multiple_family_n + ' + ' + shrink + ') = ' + fmtMult(row.category_multiple) + ', over ratios winsorized to 0.05-1.00. No single peer sets this number.';
    else multipleNote = 'Category median ' + fmtMult(row.multiple_raw_median) + ' over n=' + row.comparables_n + ' live-token peers in ' + (row.category || 'this category') + ', shrunk toward the global median ' + fmtMult(DATA.global_multiple) + ': (' + row.comparables_n + ' x ' + fmtMult(row.multiple_raw_median) + ' + ' + shrink + ' x ' + fmtMult(DATA.global_multiple) + ') / (' + row.comparables_n + ' + ' + shrink + ') = ' + fmtMult(row.category_multiple) + ', over ratios winsorized to 0.05-1.00.';
    var recomputed = impliedOf(row, DATA.model);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.watchlist ? ' - watchlist' : ' - early radar') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + '. First listed ' + (row.listed_at || 'unknown') + '.' })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Category multiple' }), el('b', { class: 'num', text: fmtMult(row.category_multiple) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: String(row.maturity_multiplier) })),
        el('div', null, el('span', { text: 'Chains (' + (row.chains || []).length + ')' }), el('b', { class: 'num', text: 'x' + row.breadth_multiplier })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('h3', { text: 'How the multiple was derived' }),
      el('p', { class: 'sub equation-note', text: multipleNote }),
      el('p', { class: 'sub', text: 'The page recomputes this row as ' + fmtUsd(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') })
    ));
    if (peers.length > 0) {
      var peerBody = el('tbody');
      peers.forEach(function (p) {
        peerBody.appendChild(el('tr', null,
          el('td', null, el('b', { text: p.name })),
          el('td', { class: 'num', text: fmtUsd(p.tvl_usd) }),
          el('td', { class: 'num', text: fmtUsd(p.mcap_usd) }),
          el('td', { class: 'num', text: p.mcap_usd && p.tvl_usd ? fmtMult(p.mcap_usd / p.tvl_usd) : 'n/a' })
        ));
      });
      dialog.appendChild(el('section', { class: 'detail-section' },
        el('h3', { text: source === 'family' ? 'Live-token peers in the ' + (row.multiple_family || multipleFamily(row.category)) + ' family' : 'Live-token peers in ' + (row.category || 'this category') }),
        el('p', { class: 'sub', text: 'Their market-cap-to-TVL ratios are the comparables behind the ' + fmtMult(row.category_multiple) + ' multiple.' }),
        el('div', { class: 'table-wrap' },
          el('table', { class: 'peers' },
            el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Mcap / TVL' }))),
            peerBody
          )
        )
      ));
    }
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      })),
      el('p', { class: 'sub', text: 'No step promises a token or an airdrop. Never pay to claim.' })
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function footer() {
    return el('footer', { class: 'foot' },
      el('p', { text: 'Source: DefiLlama protocol index, snapshot ' + DATA.as_of + '. ' + DATA.source + ' Model ' + DATA.model_version + ' ranks ' + DATA.board_size + ' pre-token protocols (' + DATA.watchlist_size + ' watchlist, ' + DATA.early_size + ' early) and sets ' + DATA.live_size + ' live-token protocols aside with their market caps.' }),
      el('p', { text: 'This board does not predict whether or when any protocol issues a token. A protocol on it records no token in the snapshot; that is not proof it has none. Farming is activity, not a guarantee of any reward.' })
    );
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  // A filtered link pasted while the page is already open must apply too:
  // same-document hash navigation does not reload the page.
  window.addEventListener('hashchange', function () {
    state.q = '';
    state.category = 'all';
    state.chain = 'all';
    state.tab = 'pre-token';
    state.watchOnly = false;
    state.selected = null;
    readHash();
    render();
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
