const SPOT_SYMBOL = 'NSE:NIFTY50-INDEX';
const toast = document.querySelector('#toast');
let toastTimer;
let currentSpotPrice = null;
let selectedExpiry = '';
let selectedExpiryDate = '';
let optionSymbols = { call: '', put: '' };
let optionContracts = { call: [], put: [] };
let selectedOptionIndex = { call: -1, put: -1 };
let optionLoading = { call: false, put: false };
let busy = false;

const series = {
  call: { symbol: '', interval: '5' },
  put: { symbol: '', interval: '5' },
  'spot-intraday': { symbol: SPOT_SYMBOL, interval: '5' },
  'spot-daily': { symbol: SPOT_SYMBOL, interval: '1D' },
};
const chartData = {};
const chartViews = {};
const seriesRequestIds = {};
const chartDrawState = Object.fromEntries(['call', 'put', 'spot-intraday', 'spot-daily'].map((kind) => [kind, {
  emaVisible: true,
  drawTrendline: false,
  trendlines: [],
  preview: null,
}]));

function showNotice(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 4200);
}

function setConnection(label, connected = false, warning = false) {
  const state = document.querySelector('#connection-state');
  const dot = connected ? 'connected' : warning ? 'warn' : 'muted';
  state.innerHTML = `<span class="status-dot ${dot}"></span><span>${label}</span>`;
}

function setNotice(message, showConnect) {
  const notice = document.querySelector('#connection-notice');
  notice.hidden = !message;
  document.querySelector('#notice-message').textContent = message || '';
  document.querySelector('#notice-connect').hidden = !showConnect;
}

function formatNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatDate(date) {
  if (!date) return '';
  const [day, month, year] = String(date).split('-');
  return day && month && year ? `${day} ${new Date(`${year}-${month}-${day}`).toLocaleDateString('en-IN', { month: 'short' })} ${year}` : String(date);
}

async function fetchApi(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

function setSpotQuote(payload) {
  const quotes = payload.d || payload.data?.d || [];
  const quote = quotes.find((entry) => entry.s === 'ok' && entry.v) || quotes[0];
  const price = Number(quote?.v?.lp);
  if (!Number.isFinite(price)) throw new Error('FYERS did not return the NIFTY spot quote.');
  currentSpotPrice = price;
  document.querySelector('#spot-price').textContent = `₹${formatNumber(price)}`;
  const change = Number(quote.v.ch);
  const changePercent = Number(quote.v.chp);
  const changeNode = document.querySelector('#spot-change');
  if (Number.isFinite(change)) {
    changeNode.textContent = `${change >= 0 ? '+' : ''}${formatNumber(change)} (${Number.isFinite(changePercent) ? `${changePercent >= 0 ? '+' : ''}${formatNumber(changePercent)}%` : '—'})`;
    changeNode.classList.toggle('positive', change >= 0);
    changeNode.classList.toggle('negative', change < 0);
  } else {
    changeNode.textContent = 'Spot quote received';
  }
  document.querySelector('#market-caption').textContent = 'NIFTY spot from FYERS · option charts use the nearest available strikes.';
}

function renderExpiryOptions(expiryData) {
  const select = document.querySelector('#expiry-select');
  const expiries = [...(expiryData || [])].sort((a, b) => Number(a.expiry) - Number(b.expiry));
  if (!expiries.length) {
    select.replaceChildren(new Option('No expiry returned', ''));
    select.disabled = true;
    selectedExpiry = '';
    selectedExpiryDate = '';
    return;
  }
  if (!expiries.some((expiry) => String(expiry.expiry) === selectedExpiry)) selectedExpiry = String(expiries[0].expiry);
  select.replaceChildren(...expiries.map((expiry) => new Option(formatDate(expiry.date), String(expiry.expiry))));
  select.value = selectedExpiry;
  select.disabled = false;
  const chosen = expiries.find((expiry) => String(expiry.expiry) === selectedExpiry) || expiries[0];
  selectedExpiryDate = formatDate(chosen.date);
}

function getContract(entry, type) {
  return entry.option_type === type || String(entry.symbol || '').endsWith(type);
}

function getContracts(entries, type) {
  return entries
    .filter((entry) => getContract(entry, type) && Number(entry.strike_price) >= 0 && entry.symbol)
    .sort((a, b) => Number(a.strike_price) - Number(b.strike_price));
}

function findNearestIndex(contracts) {
  if (!contracts.length || !Number.isFinite(currentSpotPrice)) return -1;
  return contracts.reduce((closest, contract, index) => {
    const distance = Math.abs(Number(contract.strike_price) - currentSpotPrice);
    return !closest || distance < closest.distance ? { index, distance } : closest;
  }, null)?.index ?? -1;
}

function updateContractNav(kind) {
  const index = selectedOptionIndex[kind];
  const contracts = optionContracts[kind];
  document.querySelectorAll(`[data-contract-nav="${kind}"]`).forEach((button) => {
    const direction = Number(button.dataset.direction);
    button.disabled = optionLoading[kind] || index < 0 || index + direction < 0 || index + direction >= contracts.length;
  });
}

function setSeriesLabel(kind, contract) {
  const strike = formatNumber(contract.strike_price, 0);
  const label = `NIFTY ${strike} ${kind === 'call' ? 'CE' : 'PE'}`;
  document.querySelector(`#${kind}-title`).textContent = label;
  document.querySelector(`#${kind}-symbol`).textContent = `${strike} ${kind === 'call' ? 'CE' : 'PE'}`;
  const distance = Number(contract.strike_price) - currentSpotPrice;
  const relation = Math.abs(distance) < 0.01 ? 'At spot' : `${formatNumber(Math.abs(distance), 0)} pts ${distance > 0 ? 'above' : 'below'} spot`;
  document.querySelector(`#${kind}-subtitle`).textContent = `${relation} · ${selectedExpiryDate || 'nearest expiry'} · Spot ₹${formatNumber(currentSpotPrice)}`;
}

function formatXAxisLabel(timestamp, interval) {
  const date = new Date(timestamp * 1000);
  const calendarInterval = ['1D', '1W', '1M'].includes(interval);
  return new Intl.DateTimeFormat('en-IN', calendarInterval
    ? { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }
    : { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).format(date);
}

function renderTimeAxis(kind, allCandles, interval, startIndex, windowSize) {
  const axis = document.querySelector(`#time-axis-${kind}`);
  const count = 5;
  const labels = Array.from({ length: count }, (_, index) => {
    const slot = Math.round(index * (windowSize - 1) / (count - 1));
    const candleIndex = startIndex + slot;
    return candleIndex >= 0 && candleIndex < allCandles.length
      ? formatXAxisLabel(allCandles[candleIndex][0], interval)
      : '';
  });
  axis.replaceChildren(...labels.map((value) => {
    const label = document.createElement('span');
    label.textContent = value;
    return label;
  }));
  axis.hidden = false;
}

function showEmpty(kind, message, isError = false) {
  const empty = document.querySelector(`#empty-${kind}`);
  const svg = document.querySelector(`#chart-${kind} g`);
  svg.replaceChildren();
  const timeAxis = document.querySelector(`#time-axis-${kind}`);
  timeAxis.replaceChildren();
  timeAxis.hidden = true;
  empty.replaceChildren();
  const mark = document.createElement('span');
  mark.className = 'loading-mark';
  mark.textContent = isError ? '!' : '⌁';
  const text = document.createElement('span');
  text.textContent = message;
  empty.append(mark, text);
  empty.classList.toggle('error', isError);
  empty.hidden = false;
}

function makeSvgElement(name, attributes) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
}

function calculateEma(values, period) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  let previous = values[0];
  return values.map((value, index) => {
    if (index > 0) previous = (value * multiplier) + (previous * (1 - multiplier));
    return previous;
  });
}

function formatAxisPrice(value) {
  return value >= 1000
    ? Math.round(value).toLocaleString('en-IN')
    : Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function nearestCandleIndex(candles, timestamp) {
  let low = 0;
  let high = candles.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle][0] === timestamp) return middle;
    if (candles[middle][0] < timestamp) low = middle + 1;
    else high = middle - 1;
  }
  if (low >= candles.length) return candles.length - 1;
  if (high < 0) return 0;
  return timestamp - candles[high][0] <= candles[low][0] - timestamp ? high : low;
}

function drawCandles(kind, payload, symbol, interval) {
  const raw = payload.candles || payload.data?.candles || [];
  const allCandles = raw
    .filter((row) => Array.isArray(row) && row.length >= 5 && row.slice(0, 5).every((value) => Number.isFinite(Number(value))))
    .map((row) => row.slice(0, 5).map(Number))
    .sort((a, b) => a[0] - b[0]);
  if (!allCandles.length) throw new Error('No historical candles are available for this symbol and interval.');
  chartData[kind] = { payload, symbol, interval, candles: allCandles };
  const previousView = chartViews[kind];
  if (!previousView) {
    const initialWindow = ['1D', '1W', '1M'].includes(interval) ? 180 : 120;
    chartViews[kind] = { window: Math.min(initialWindow, allCandles.length), end: allCandles.length, total: allCandles.length, priceScale: 1, priceOffset: 0 };
  } else {
    const historyChanged = previousView.total !== allCandles.length;
    const wasAtLatest = previousView.end >= previousView.total;
    if (historyChanged && wasAtLatest) previousView.end = allCandles.length;
    previousView.window = Math.max(1, Math.min(previousView.window, allCandles.length));
    previousView.end = Math.max(previousView.window, Math.min(previousView.end, allCandles.length + previousView.window - 1));
    previousView.total = allCandles.length;
  }
  const view = chartViews[kind];
  const drawState = chartDrawState[kind];
  const startIndex = view.end - view.window;
  const firstDataIndex = Math.max(0, startIndex);
  const candles = allCandles.slice(firstDataIndex, Math.min(view.end, allCandles.length));

  const dataLow = Math.min(...candles.map((row) => row[3]));
  const dataHigh = Math.max(...candles.map((row) => row[2]));
  const dataMid = (dataLow + dataHigh) / 2 + (view.priceOffset || 0);
  const span = Math.max(dataHigh - dataLow, Math.abs(dataHigh) * 0.0001, 0.01) * (view.priceScale || 1);
  view.priceSpan = span;
  const pricesLow = dataMid - span / 2;
  const pricesHigh = dataMid + span / 2;
  const left = 4;
  const right = 675;
  const axisLeft = 692;
  const axisTextX = 756;
  const top = 6;
  const bottom = 174;
  const y = (price) => bottom - ((price - pricesLow) / span) * (bottom - top);
  const gap = (right - left) / view.window;
  const width = Math.max(1.4, Math.min(8, gap * 0.58));
  const gridGroup = makeSvgElement('g', { class: 'price-grid' });
  const candleGroup = makeSvgElement('g', { class: 'candle-layer' });
  const emaGroup = makeSvgElement('g', { class: 'ema-layer' });
  emaGroup.style.display = drawState.emaVisible ? '' : 'none';
  const trendGroup = makeSvgElement('g', { class: 'trendline-layer', 'clip-path': `url(#trend-clip-${kind})` });
  const definitions = makeSvgElement('defs', {});
  const trendClip = makeSvgElement('clipPath', { id: `trend-clip-${kind}` });
  trendClip.append(makeSvgElement('rect', { x: left, y: top, width: right - left, height: bottom - top }));
  definitions.append(trendClip);
  const axisGroup = makeSvgElement('g', { class: 'price-axis' });
  axisGroup.append(makeSvgElement('rect', {
    x: axisLeft + 1, y: 0, width: 760 - axisLeft, height: 180, class: 'price-axis-bg',
  }));

  for (let tick = 0; tick <= 4; tick += 1) {
    const ratio = tick / 4;
    const yPosition = top + ratio * (bottom - top);
    const price = pricesHigh - ratio * span;
    gridGroup.append(makeSvgElement('line', {
      x1: left, x2: axisLeft - 4, y1: yPosition.toFixed(2), y2: yPosition.toFixed(2), class: 'price-grid-line',
    }));
    const label = makeSvgElement('text', {
      x: axisTextX, y: (yPosition + 3).toFixed(2), class: 'price-axis-label', 'text-anchor': 'end',
    });
    label.textContent = formatAxisPrice(price);
    axisGroup.append(label);
  }
  axisGroup.append(makeSvgElement('line', {
    x1: axisLeft, x2: axisLeft, y1: top, y2: bottom, class: 'price-axis-line',
  }));
  axisGroup.append(makeSvgElement('rect', {
    x: axisLeft, y: 0, width: 760 - axisLeft, height: 180, class: 'price-scale-hit',
  }));

  for (const [index, row] of candles.entries()) {
    const [, open, high, low, close] = row;
    const slot = firstDataIndex - startIndex + index;
    const x = left + (slot + 0.5) * gap;
    const up = close >= open;
    const className = up ? 'candle-up' : 'candle-down';
    const wick = makeSvgElement('line', {
      x1: x.toFixed(2), y1: y(high).toFixed(2), x2: x.toFixed(2), y2: y(low).toFixed(2), class: `candle-wick ${className}`,
    });
    const bodyTop = Math.min(y(open), y(close));
    const bodyHeight = Math.max(1.2, Math.abs(y(open) - y(close)));
    const body = makeSvgElement('rect', {
      x: (x - width / 2).toFixed(2), y: bodyTop.toFixed(2), width: width.toFixed(2), height: bodyHeight.toFixed(2), rx: 0.7, class: className,
    });
    candleGroup.append(wick, body);
  }

  const closes = candles.map((row) => row[4]);
  for (const period of [50, 100, 200]) {
    const values = calculateEma(closes, period);
    const points = values.map((value, index) => {
      const slot = firstDataIndex - startIndex + index;
      const x = left + (slot + 0.5) * gap;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y(value).toFixed(2)}`;
    }).join(' ');
    emaGroup.append(makeSvgElement('path', { d: points, class: `ema-line ema-line-${period}` }));
    document.querySelector(`#ema-${kind}-${period}`).textContent = formatNumber(values[values.length - 1]);
  }

  const visibleTrendlines = drawState.trendlines.filter((line) => line.symbol === symbol && line.interval === interval);
  if (drawState.preview?.symbol === symbol && drawState.preview?.interval === interval) visibleTrendlines.push(drawState.preview);
  for (const line of visibleTrendlines) {
    const pointToSvg = (point) => {
      const index = nearestCandleIndex(allCandles, point.timestamp);
      const visibleIndex = index - (view.end - view.window);
      return {
        x: left + (visibleIndex + 0.5) * gap,
        y: y(point.price),
      };
    };
    const start = pointToSvg(line.start);
    const end = pointToSvg(line.end);
    trendGroup.append(makeSvgElement('line', {
      x1: start.x.toFixed(2), y1: start.y.toFixed(2),
      x2: end.x.toFixed(2), y2: end.y.toFixed(2),
      class: line.preview ? 'trend-line trend-line-preview' : 'trend-line',
    }));
  }

  document.querySelector(`#chart-${kind} g`).replaceChildren(definitions, gridGroup, candleGroup, emaGroup, trendGroup, axisGroup);
  document.querySelector(`[data-chart-card="${kind}"]`).classList.toggle('indicators-hidden', !drawState.emaVisible);
  document.querySelector(`#empty-${kind}`).hidden = true;
  renderTimeAxis(kind, allCandles, interval, startIndex, view.window);
  const latest = candles[candles.length - 1];
  const isDaily = interval === '1D' || interval === '1W' || interval === '1M';
  const stamp = new Date(latest[0] * 1000);
  const timeLabel = new Intl.DateTimeFormat('en-IN', isDaily
    ? { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }
    : { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(stamp);
  document.querySelector(`#status-${kind}`).textContent = `${interval} · ${candles.length} candles`;
  document.querySelector(`#last-${kind}`).textContent = `Close ₹${formatNumber(latest[4])} · ${timeLabel}${isDaily ? '' : ' IST'} · ${symbol}`;
}

async function loadSeries(kind, symbol = series[kind].symbol, interval = series[kind].interval) {
  if (!symbol) {
    showEmpty(kind, 'Waiting for the nearest option contract');
    return;
  }
  if (series[kind].interval !== interval || series[kind].symbol !== symbol) delete chartViews[kind];
  series[kind] = { symbol, interval };
  seriesRequestIds[kind] = (seriesRequestIds[kind] || 0) + 1;
  const requestId = seriesRequestIds[kind];
  const intervalSelect = document.querySelector(`#interval-${kind}`);
  if (intervalSelect) intervalSelect.value = interval;
  document.querySelector(`#status-${kind}`).textContent = 'Loading candles';
  showEmpty(kind, 'Loading historical candles');
  const query = new URLSearchParams({ symbol, resolution: interval });
  try {
    const result = await fetchApi(`/api/market/history?${query}`);
    if (seriesRequestIds[kind] !== requestId) return;
    drawCandles(kind, result, symbol, interval);
  } catch (error) {
    if (seriesRequestIds[kind] !== requestId) return;
    showEmpty(kind, error.message, true);
    document.querySelector(`#status-${kind}`).textContent = 'Chart unavailable';
    throw error;
  }
}

async function loadSelectedOption(kind) {
  const contract = optionContracts[kind][selectedOptionIndex[kind]];
  if (!contract) return;
  optionSymbols[kind] = contract.symbol;
  optionLoading[kind] = true;
  setSeriesLabel(kind, contract);
  updateContractNav(kind);
  try {
    await loadSeries(kind, contract.symbol, series[kind].interval);
  } finally {
    optionLoading[kind] = false;
    updateContractNav(kind);
  }
}

async function changeOptionContract(kind, direction) {
  const nextIndex = selectedOptionIndex[kind] + direction;
  if (nextIndex < 0 || nextIndex >= optionContracts[kind].length || optionLoading[kind]) return;
  selectedOptionIndex[kind] = nextIndex;
  try {
    await loadSelectedOption(kind);
  } catch (error) {
    showNotice(error.message);
  }
}

async function updateNearestOptions(payload) {
  const data = payload.data || payload;
  renderExpiryOptions(data.expiryData || []);
  const entries = data.optionsChain || [];
  if (!currentSpotPrice || !entries.length) throw new Error('The option chain or NIFTY spot quote is unavailable.');
  optionContracts = { call: getContracts(entries, 'CE'), put: getContracts(entries, 'PE') };
  selectedOptionIndex = {
    call: findNearestIndex(optionContracts.call),
    put: findNearestIndex(optionContracts.put),
  };
  if (selectedOptionIndex.call < 0 || selectedOptionIndex.put < 0) throw new Error('FYERS did not return both CE and PE contracts near spot.');
  updateContractNav('call');
  updateContractNav('put');
  return Promise.allSettled([
    loadSelectedOption('call'),
    loadSelectedOption('put'),
  ]);
}

async function loadOptionChain(timestamp = selectedExpiry) {
  const query = new URLSearchParams({ symbol: SPOT_SYMBOL, strikecount: '25' });
  if (timestamp) query.set('timestamp', timestamp);
  document.querySelector('#call-subtitle').textContent = 'Loading nearest available call strike…';
  document.querySelector('#put-subtitle').textContent = 'Loading nearest available put strike…';
  const result = await fetchApi(`/api/market/option-chain?${query}`);
  const expiryData = (result.data || result).expiryData || [];
  renderExpiryOptions(expiryData);
  return updateNearestOptions(result);
}

async function loadSpotSeries() {
  return Promise.allSettled([
    loadSeries('spot-intraday', SPOT_SYMBOL, series['spot-intraday'].interval),
    loadSeries('spot-daily', SPOT_SYMBOL, series['spot-daily'].interval),
  ]);
}

async function loadMarketData() {
  if (busy) return;
  busy = true;
  const refreshButton = document.querySelector('#refresh-all');
  refreshButton.disabled = true;
  setConnection('Loading market data');
  document.querySelector('#market-caption').textContent = 'Fetching NIFTY spot, nearest option contracts, and historical candles…';
  try {
    const [quoteResult, chainResult] = await Promise.allSettled([
      fetchApi(`/api/market/quote?${new URLSearchParams({ symbol: SPOT_SYMBOL })}`),
      fetchApi(`/api/market/option-chain?${new URLSearchParams({ symbol: SPOT_SYMBOL, strikecount: '25', ...(selectedExpiry ? { timestamp: selectedExpiry } : {}) })}`),
    ]);
    let quoteError = null;
    let chainError = null;
    if (quoteResult.status === 'fulfilled') {
      try { setSpotQuote(quoteResult.value); } catch (error) { quoteError = error; }
    } else quoteError = quoteResult.reason;
    if (chainResult.status === 'fulfilled') {
      try {
        const expiries = (chainResult.value.data || chainResult.value).expiryData || [];
        renderExpiryOptions(expiries);
        const optionResults = await updateNearestOptions(chainResult.value);
        const optionError = optionResults.find((result) => result.status === 'rejected');
        if (optionError && !chainError) chainError = optionError.reason;
      } catch (error) { chainError = error; }
    } else chainError = chainResult.reason;
    const spotResults = await loadSpotSeries();
    const spotError = spotResults.find((result) => result.status === 'rejected');

    const authError = [quoteError, chainError, spotError?.reason].find((error) => /session expired|reconnect to fyers/i.test(error?.message || ''));
    if (authError) {
      setConnection('FYERS login required', false, true);
      setNotice(authError.message, true);
      return;
    }
    if (quoteError || chainError) {
      setConnection('Market data partial', false, true);
      setNotice((quoteError || chainError).message, true);
    } else {
      setConnection('FYERS market data', true);
      setNotice('', false);
    }
    if (spotError) showNotice(spotError.reason.message);
  } catch (error) {
    setConnection('Market data unavailable', false, true);
    setNotice(error.message, true);
  } finally {
    refreshButton.disabled = false;
    busy = false;
  }
}

async function refreshConnectionStatus() {
  const connectButton = document.querySelector('#connect-data');
  const disconnectButton = document.querySelector('#disconnect-data');
  try {
    const status = await fetchApi('/api/status');
    if (status.connected) {
      setConnection('FYERS session active', true);
      connectButton.textContent = 'Connect';
      connectButton.disabled = true;
      disconnectButton.disabled = false;
      setNotice('', false);
      await loadMarketData();
    } else if (status.configured) {
      setConnection('FYERS login needed', false, true);
      connectButton.textContent = 'Connect';
      connectButton.disabled = false;
      disconnectButton.disabled = true;
      setNotice('Sign in to FYERS to load the NIFTY spot quote, options, and charts.', true);
    } else {
      setConnection('Setup needed', false, true);
      connectButton.textContent = 'Connect';
      connectButton.disabled = true;
      disconnectButton.disabled = true;
      setNotice('Add the FYERS App ID and Secret ID to the local .env file, then set the matching redirect URL.', false);
    }
  } catch {
    setConnection('Local server unavailable', false, true);
    connectButton.textContent = 'Connect';
    connectButton.disabled = true;
    disconnectButton.disabled = true;
    setNotice('Start the local app server with python server.py.', false);
  }
}

function startLogin() {
  window.location.assign('/auth/login');
}

async function disconnectFyers() {
  const disconnectButton = document.querySelector('#disconnect-data');
  disconnectButton.disabled = true;
  disconnectButton.textContent = 'Disconnecting…';
  try {
    await fetchApi('/api/disconnect', { method: 'POST' });
    window.location.reload();
  } catch (error) {
    disconnectButton.disabled = false;
    disconnectButton.textContent = 'Disconnect';
    showNotice(error.message || 'Could not disconnect FYERS.');
  }
}

const settingsStorageKey = 'options-desk-trading-settings';
const settingsForm = document.querySelector('#trading-settings');
const settingsStatus = document.querySelector('#settings-status');
const settingsFields = {
  capital: document.querySelector('#capital-input'),
  lots: document.querySelector('#lots-input'),
  profit: document.querySelector('#profit-input'),
  stopLoss: document.querySelector('#stop-loss-input'),
};

try {
  const savedSettings = JSON.parse(localStorage.getItem(settingsStorageKey) || 'null');
  if (savedSettings && typeof savedSettings === 'object') {
    for (const [key, field] of Object.entries(settingsFields)) {
      if (savedSettings[key] !== undefined && Number.isFinite(Number(savedSettings[key]))) {
        field.value = String(savedSettings[key]);
      }
    }
    if (Object.values(settingsFields).every((field) => field.value !== '')) {
      settingsStatus.textContent = 'Your trading defaults are saved on this device.';
    }
  }
} catch {
  settingsStatus.textContent = 'Browser storage is unavailable; settings will not persist.';
}

settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!settingsForm.reportValidity()) return;
  const settings = Object.fromEntries(
    Object.entries(settingsFields).map(([key, field]) => [key, Number(field.value)]),
  );
  if (!Number.isInteger(settings.lots)) {
    settingsFields.lots.setCustomValidity('Enter a whole number of lots.');
    settingsFields.lots.reportValidity();
    settingsFields.lots.setCustomValidity('');
    return;
  }
  try {
    localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
    settingsStatus.textContent = 'Your trading defaults are saved on this device.';
    showNotice('Trading settings saved.');
  } catch {
    settingsStatus.textContent = 'Could not save settings in this browser.';
  }
});

const paperOrdersStorageKey = 'options-desk-paper-orders';
let refreshingPaperQuotes = false;

function readPaperOrders() {
  try {
    const stored = JSON.parse(localStorage.getItem(paperOrdersStorageKey) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function savePaperOrders(orders) {
  localStorage.setItem(paperOrdersStorageKey, JSON.stringify(orders));
}

function addRealizedPnlToCapital(pnl) {
  let settings;
  try {
    settings = JSON.parse(localStorage.getItem(settingsStorageKey) || 'null');
  } catch {
    settings = null;
  }
  if (!settings || !Number.isFinite(Number(settings.capital))) return;
  settings.capital = Number(settings.capital) + pnl;
  try {
    localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
    settingsFields.capital.value = String(settings.capital);
    settingsStatus.textContent = 'Trading capital updated with the latest realized P&L.';
  } catch {
    showNotice('Position closed, but the updated trading capital could not be saved.');
  }
}

function showNoOrders(target, message) {
  const empty = document.createElement('div');
  empty.className = 'orders-empty';
  empty.textContent = message;
  target.replaceChildren(empty);
}

function createOrderMetric(label, value, className = '') {
  const metric = document.createElement('div');
  metric.className = 'order-metric';
  const title = document.createElement('span');
  title.textContent = label;
  const amount = document.createElement('strong');
  amount.textContent = value;
  if (className) amount.classList.add(className);
  metric.append(title, amount);
  return metric;
}

function createOrderCard(order) {
  const card = document.createElement('article');
  card.className = 'paper-order-card';
  const header = document.createElement('header');
  header.className = 'paper-order-header';
  const instrument = document.createElement('div');
  instrument.className = 'paper-order-instrument';
  const symbol = document.createElement('strong');
  symbol.textContent = order.symbol;
  const details = document.createElement('span');
  const createdAt = new Date(order.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  details.textContent = `${order.id} · BUY · MARKET · ${createdAt}`;
  instrument.append(symbol, details);
  const status = document.createElement('span');
  status.className = `order-status ${order.status === 'OPEN' ? 'status-open' : 'status-closed'}`;
  status.textContent = order.status === 'OPEN'
    ? 'OPEN'
    : order.status === 'TARGET' ? 'TARGET HIT' : order.status === 'STOP_LOSS' ? 'STOP LOSS' : 'MANUAL EXIT';
  const actions = document.createElement('div');
  actions.className = 'paper-order-actions';
  actions.append(status);
  if (order.status === 'OPEN') {
    const exitButton = document.createElement('button');
    exitButton.type = 'button';
    exitButton.className = 'button order-exit-button';
    exitButton.textContent = 'Exit position';
    exitButton.setAttribute('aria-label', `Exit paper position ${order.symbol}`);
    exitButton.addEventListener('click', () => exitPaperPosition(order.id, exitButton));
    actions.append(exitButton);
  }
  header.append(instrument, actions);

  const metrics = document.createElement('div');
  metrics.className = 'order-metrics';
  const isOpen = order.status === 'OPEN';
  const pnl = isOpen
    ? (Number(order.lastPrice || order.entryPrice) - Number(order.entryPrice)) * Number(order.quantity)
    : Number(order.realizedPnl || 0);
  metrics.append(
    createOrderMetric('Quantity', `${formatNumber(order.quantity, 0)} units · ${formatNumber(order.lots, 0)} lot${Number(order.lots) === 1 ? '' : 's'}`),
    createOrderMetric('Entry price', `₹${formatNumber(order.entryPrice)}`),
    createOrderMetric(isOpen ? 'LTP' : 'Exit price', `₹${formatNumber(isOpen ? order.lastPrice || order.entryPrice : order.exitPrice)}`),
    createOrderMetric('Stop loss', `₹${formatNumber(order.stopLossPrice)}`),
    createOrderMetric('Profit target', `₹${formatNumber(order.targetPrice)}`),
    createOrderMetric(isOpen ? 'Unrealized P&L' : 'Realized P&L', `${pnl >= 0 ? '+' : '−'}₹${formatNumber(Math.abs(pnl))}`, pnl >= 0 ? 'pnl-positive' : 'pnl-negative'),
  );
  card.append(header, metrics);
  return card;
}

function renderPaperOrders() {
  const orders = readPaperOrders().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const active = orders.filter((order) => order.status === 'OPEN');
  const completed = orders.filter((order) => order.status !== 'OPEN');
  document.querySelector('#orders-summary').textContent = `${active.length} open · ${completed.length} completed`;
  const totalPnl = orders.reduce((sum, order) => {
    if (order.status === 'OPEN') {
      return sum + (Number(order.lastPrice || order.entryPrice) - Number(order.entryPrice)) * Number(order.quantity);
    }
    return sum + Number(order.realizedPnl || 0);
  }, 0);
  const totalPnlLabel = document.querySelector('#orders-total-pnl');
  totalPnlLabel.textContent = `${totalPnl >= 0 ? '+' : '−'}₹${formatNumber(Math.abs(totalPnl))}`;
  totalPnlLabel.classList.toggle('pnl-positive', totalPnl >= 0);
  totalPnlLabel.classList.toggle('pnl-negative', totalPnl < 0);
  const openList = document.querySelector('#open-orders-list');
  const completedList = document.querySelector('#completed-orders-list');
  if (active.length) openList.replaceChildren(...active.map(createOrderCard));
  else showNoOrders(openList, 'No active paper orders. Buy a CE or PE contract from the chart to create one.');
  const completedGroup = document.querySelector('#completed-orders-group');
  completedGroup.hidden = completed.length === 0;
  if (completed.length) completedList.replaceChildren(...completed.slice(0, 25).map(createOrderCard));
  else completedList.replaceChildren();
}

function quotePrice(payload, symbol) {
  const quotes = payload.d || payload.data?.d || [];
  const quote = quotes.find((entry) => entry.v && (!entry.n || entry.n === symbol)) || quotes[0];
  const price = Number(quote?.v?.lp);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`FYERS did not return a valid price for ${symbol}.`);
  return price;
}

async function exitPaperPosition(orderId, button) {
  const orders = readPaperOrders();
  const order = orders.find((item) => item.id === orderId && item.status === 'OPEN');
  if (!order) return;
  button.disabled = true;
  button.textContent = 'Exiting…';
  try {
    const payload = await fetchApi(`/api/market/quote?${new URLSearchParams({ symbol: order.symbol })}`);
    const exitPrice = quotePrice(payload, order.symbol);
    order.status = 'EXITED';
    order.exitPrice = exitPrice;
    order.lastPrice = exitPrice;
    order.realizedPnl = (exitPrice - Number(order.entryPrice)) * Number(order.quantity);
    order.closedAt = new Date().toISOString();
    order.exitReason = 'MANUAL';
    savePaperOrders(orders);
    addRealizedPnlToCapital(order.realizedPnl);
    renderPaperOrders();
    const result = order.realizedPnl >= 0 ? 'profit' : 'loss';
    showNotice(`Paper position exited at ₹${formatNumber(exitPrice)} · ${result} ₹${formatNumber(Math.abs(order.realizedPnl))}.`);
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Exit position';
    showNotice(error.message || 'Could not exit the paper position.');
  }
}

async function buyPaperOption(kind) {
  const button = document.querySelector(`[data-paper-buy="${kind}"]`);
  const settings = (() => {
    try { return JSON.parse(localStorage.getItem(settingsStorageKey) || 'null'); } catch { return null; }
  })();
  if (!settings || !settings.capital || !settings.lots || !settings.profit || !settings.stopLoss) {
    showAppView('settings');
    showNotice('Save your trading settings before placing a paper order.');
    return;
  }
  const symbol = optionSymbols[kind];
  if (!symbol) {
    showNotice('Wait for the option chain to load before placing an order.');
    return;
  }
  const capital = Number(settings.capital);
  const lots = Number(settings.lots);
  const profitPoints = Number(settings.profit);
  const stopLossPoints = Number(settings.stopLoss);
  if (!(capital > 0) || !Number.isInteger(lots) || lots < 1 || !(profitPoints > 0) || !(stopLossPoints > 0)) {
    showAppView('settings');
    showNotice('Check and save valid trading settings before placing an order.');
    return;
  }

  button.disabled = true;
  button.textContent = 'Buying…';
  try {
    const payload = await fetchApi(`/api/market/quote?${new URLSearchParams({ symbol })}`);
    const entryPrice = quotePrice(payload, symbol);
    const quantity = lots * 65;
    const openOrders = readPaperOrders().filter((order) => order.status === 'OPEN');
    const usedCapital = openOrders.reduce((sum, order) => sum + Number(order.entryPrice) * Number(order.quantity), 0);
    const orderValue = entryPrice * quantity;
    if (usedCapital + orderValue > capital) {
      throw new Error(`Order value ₹${formatNumber(orderValue)} would exceed the saved trading capital after open positions.`);
    }
    const now = new Date();
    const orders = readPaperOrders();
    const order = {
      id: `PAPER-${now.getTime().toString(36).toUpperCase()}`,
      symbol,
      side: 'BUY',
      orderType: 'MARKET',
      status: 'OPEN',
      lots,
      lotSize: 65,
      quantity,
      entryPrice,
      lastPrice: entryPrice,
      stopLossPrice: entryPrice - stopLossPoints,
      targetPrice: entryPrice + profitPoints,
      createdAt: now.toISOString(),
    };
    orders.unshift(order);
    savePaperOrders(orders);
    renderPaperOrders();
    showNotice(`Paper buy filled: ${symbol} · ${quantity} units at ₹${formatNumber(entryPrice)}.`);
  } catch (error) {
    showNotice(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Buy';
  }
}

async function refreshPaperOrders() {
  if (refreshingPaperQuotes) return;
  const orders = readPaperOrders();
  const active = orders.filter((order) => order.status === 'OPEN');
  if (!active.length) {
    renderPaperOrders();
    return;
  }
  refreshingPaperQuotes = true;
  const button = document.querySelector('#refresh-orders');
  button.disabled = true;
  const completedNow = [];
  let capitalAdjustment = 0;
  try {
    await Promise.all(active.map(async (order) => {
      try {
        const payload = await fetchApi(`/api/market/quote?${new URLSearchParams({ symbol: order.symbol })}`);
        const price = quotePrice(payload, order.symbol);
        order.lastPrice = price;
        if (price <= Number(order.stopLossPrice)) {
          order.status = 'STOP_LOSS';
          order.exitPrice = price;
          order.realizedPnl = (price - Number(order.entryPrice)) * Number(order.quantity);
          capitalAdjustment += order.realizedPnl;
          order.closedAt = new Date().toISOString();
          completedNow.push(`${order.symbol} reached stop loss.`);
        } else if (price >= Number(order.targetPrice)) {
          order.status = 'TARGET';
          order.exitPrice = Number(order.targetPrice);
          order.realizedPnl = (Number(order.targetPrice) - Number(order.entryPrice)) * Number(order.quantity);
          capitalAdjustment += order.realizedPnl;
          order.closedAt = new Date().toISOString();
          completedNow.push(`${order.symbol} reached the profit target.`);
        }
      } catch { /* Keep the last known quote if FYERS is temporarily unavailable. */ }
    }));
    savePaperOrders(orders);
    if (capitalAdjustment !== 0) addRealizedPnlToCapital(capitalAdjustment);
    renderPaperOrders();
    if (completedNow.length) showNotice(completedNow.join(' '));
  } finally {
    refreshingPaperQuotes = false;
    button.disabled = false;
  }
}

const themeToggle = document.querySelector('#theme-toggle');
function setTheme(theme) {
  const light = theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  themeToggle.textContent = light ? '☾ Dark' : '☼ Light';
  themeToggle.setAttribute('aria-label', `Switch to ${light ? 'dark' : 'light'} mode`);
  themeToggle.setAttribute('aria-pressed', String(light));
}
try {
  setTheme(localStorage.getItem('options-desk-theme') || 'dark');
} catch {
  setTheme('dark');
}
themeToggle.addEventListener('click', () => {
  const nextTheme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  setTheme(nextTheme);
  try { localStorage.setItem('options-desk-theme', nextTheme); } catch { /* Theme still applies for this page view. */ }
});

function showAppView(view) {
  const workspaceOpen = view === 'workspace';
  document.querySelector('#workspace-view').hidden = !workspaceOpen;
  document.querySelector('#settings-view').hidden = view !== 'settings';
  document.querySelector('#orders-view').hidden = view !== 'orders';
  document.querySelector('#workspace-actions').hidden = !workspaceOpen;
  document.querySelector('#settings-actions').hidden = workspaceOpen;
  window.scrollTo(0, 0);
}
document.querySelector('#open-settings').addEventListener('click', () => showAppView('settings'));
document.querySelector('#back-to-workspace').addEventListener('click', () => showAppView('workspace'));
document.querySelector('#open-orders').addEventListener('click', () => {
  renderPaperOrders();
  showAppView('orders');
  refreshPaperOrders();
});
document.querySelector('#refresh-orders').addEventListener('click', refreshPaperOrders);
document.querySelectorAll('[data-paper-buy]').forEach((button) => {
  button.addEventListener('click', () => buyPaperOption(button.dataset.paperBuy));
});
renderPaperOrders();
window.setInterval(refreshPaperOrders, 15000);

function redrawChart(kind) {
  const data = chartData[kind];
  if (data) drawCandles(kind, data.payload, data.symbol, data.interval);
}

function zoomChart(kind, action, anchorRatio = 1) {
  const data = chartData[kind];
  const view = chartViews[kind];
  if (!data || !view) return;
  const total = view.total;
  if (action === 'reset') {
    view.window = total;
    view.end = total;
    view.priceScale = 1;
    view.priceOffset = 0;
  } else {
    const oldWindow = view.window;
    const newWindow = action === 'in'
      ? Math.max(Math.min(20, total), Math.floor(oldWindow / 1.25))
      : Math.min(total, Math.ceil(oldWindow * 1.25));
    const anchorIndex = view.end - oldWindow + Math.max(0, Math.min(1, anchorRatio)) * oldWindow;
    const start = anchorIndex - Math.max(0, Math.min(1, anchorRatio)) * newWindow;
    view.window = newWindow;
    view.end = Math.max(newWindow, Math.min(total, Math.round(start + newWindow)));
  }
  redrawChart(kind);
}

document.querySelectorAll('[data-chart-zoom]').forEach((button) => {
  button.addEventListener('click', () => zoomChart(button.dataset.chartZoom, button.dataset.action));
});

function updateChartTools(kind) {
  const drawState = chartDrawState[kind];
  const emaButton = document.querySelector(`[data-indicator-toggle="${kind}"]`);
  emaButton.textContent = drawState.emaVisible ? 'EMA On' : 'EMA Off';
  emaButton.setAttribute('aria-pressed', String(drawState.emaVisible));
  emaButton.setAttribute('aria-label', `${drawState.emaVisible ? 'Turn off' : 'Turn on'} ${kind} chart EMAs`);
  const trendButton = document.querySelector(`[data-trendline-toggle="${kind}"]`);
  trendButton.textContent = drawState.drawTrendline ? 'Cancel line' : '↗ Line';
  trendButton.classList.toggle('is-active', drawState.drawTrendline);
  trendButton.setAttribute('aria-pressed', String(drawState.drawTrendline));
  document.querySelector(`[data-trendline-clear="${kind}"]`).disabled = drawState.trendlines.length === 0;
  document.querySelector(`#chart-${kind}`).classList.toggle('draw-mode', drawState.drawTrendline);
}

document.querySelectorAll('[data-indicator-toggle]').forEach((button) => {
  button.addEventListener('click', () => {
    const kind = button.dataset.indicatorToggle;
    chartDrawState[kind].emaVisible = !chartDrawState[kind].emaVisible;
    updateChartTools(kind);
    redrawChart(kind);
  });
});

document.querySelectorAll('[data-trendline-toggle]').forEach((button) => {
  button.addEventListener('click', () => {
    const kind = button.dataset.trendlineToggle;
    chartDrawState[kind].drawTrendline = !chartDrawState[kind].drawTrendline;
    updateChartTools(kind);
    showNotice(chartDrawState[kind].drawTrendline
      ? 'Trend line mode: drag across the chart from the start point to the end point.'
      : 'Trend line mode cancelled.');
  });
});

document.querySelectorAll('[data-trendline-clear]').forEach((button) => {
  button.addEventListener('click', () => {
    const kind = button.dataset.trendlineClear;
    chartDrawState[kind].trendlines = [];
    chartDrawState[kind].preview = null;
    updateChartTools(kind);
    redrawChart(kind);
  });
});

function chartPointFromEvent(kind, svg, event) {
  const data = chartData[kind];
  const view = chartViews[kind];
  if (!data || !view) return null;
  const startIndex = view.end - view.window;
  const visible = data.candles.slice(Math.max(0, startIndex), Math.min(view.end, data.candles.length));
  if (!visible.length) return null;
  const bounds = svg.getBoundingClientRect();
  const viewX = ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) * 760;
  const viewY = ((event.clientY - bounds.top) / Math.max(bounds.height, 1)) * 180;
  const plotX = Math.max(4, Math.min(675, viewX));
  const slot = Math.max(0, Math.min(view.window - 1, Math.floor(((plotX - 4) / (675 - 4)) * view.window)));
  const globalIndex = Math.max(0, Math.min(data.candles.length - 1, startIndex + slot));
  const pricesLow = Math.min(...visible.map((row) => row[3]));
  const pricesHigh = Math.max(...visible.map((row) => row[2]));
  const dataMid = (pricesLow + pricesHigh) / 2 + (view.priceOffset || 0);
  const span = Math.max(pricesHigh - pricesLow, Math.abs(pricesHigh) * 0.0001, 0.01) * (view.priceScale || 1);
  const scaledHigh = dataMid + span / 2;
  const yPosition = Math.max(6, Math.min(174, viewY));
  const price = scaledHigh - ((yPosition - 6) / (174 - 6)) * span;
  return { timestamp: data.candles[globalIndex][0], price };
}

document.querySelectorAll('.candlestick-chart').forEach((svg) => {
  const kind = svg.id.replace('chart-', '');
  let dragStart = null;
  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const view = chartViews[kind];
    if (!view) return;
    const bounds = svg.getBoundingClientRect();
    const viewBoxX = ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) * 760;
    if (viewBoxX >= 692) {
      dragStart = { mode: 'price-scale', y: event.clientY, priceScale: view.priceScale || 1 };
    } else if (chartDrawState[kind].drawTrendline) {
      const start = chartPointFromEvent(kind, svg, event);
      if (!start) return;
      dragStart = { mode: 'trendline', start, x: event.clientX, y: event.clientY };
      chartDrawState[kind].preview = { symbol: chartData[kind].symbol, interval: chartData[kind].interval, start, end: start, preview: true };
    } else {
      dragStart = { mode: 'pan', x: event.clientX, y: event.clientY, end: view.end, priceOffset: view.priceOffset || 0, priceSpan: view.priceSpan || 1 };
    }
    svg.classList.add('is-dragging');
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', (event) => {
    if (!dragStart) return;
    const view = chartViews[kind];
    if (!view) return;
    if (dragStart.mode === 'price-scale') {
      const verticalChange = event.clientY - dragStart.y;
      view.priceScale = Math.max(0.12, Math.min(12, dragStart.priceScale * Math.exp(verticalChange * 0.012)));
    } else if (dragStart.mode === 'trendline') {
      const end = chartPointFromEvent(kind, svg, event);
      if (end && chartDrawState[kind].preview) chartDrawState[kind].preview.end = end;
    } else {
      const moved = Math.round(((dragStart.x - event.clientX) / Math.max(svg.clientWidth, 1)) * view.window);
      view.end = Math.max(view.window, Math.min(view.total + view.window - 1, dragStart.end + moved));
      const bounds = svg.getBoundingClientRect();
      const deltaViewY = ((event.clientY - dragStart.y) / Math.max(bounds.height, 1)) * 180;
      view.priceOffset = dragStart.priceOffset + (deltaViewY * dragStart.priceSpan / (174 - 6));
    }
    redrawChart(kind);
  });
  const finishDrag = (event, cancelled = false) => {
    if (dragStart?.mode === 'trendline') {
      const drawState = chartDrawState[kind];
      const end = event ? chartPointFromEvent(kind, svg, event) : null;
      if (!cancelled && end && Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) >= 4) {
        drawState.trendlines.push({
          symbol: chartData[kind].symbol,
          interval: chartData[kind].interval,
          start: dragStart.start,
          end,
        });
        showNotice('Trend line added. Use Clear to remove it.');
      }
      drawState.preview = null;
      drawState.drawTrendline = false;
      updateChartTools(kind);
      redrawChart(kind);
    }
    dragStart = null;
    svg.classList.remove('is-dragging');
  };
  svg.addEventListener('pointerup', (event) => finishDrag(event));
  svg.addEventListener('pointercancel', (event) => finishDrag(event, true));
  svg.addEventListener('lostpointercapture', (event) => finishDrag(event, true));
  svg.addEventListener('wheel', (event) => {
    if (!chartData[kind]) return;
    event.preventDefault();
    const bounds = svg.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    zoomChart(kind, event.deltaY < 0 ? 'in' : 'out', ratio);
  }, { passive: false });
});

['call', 'put', 'spot-intraday', 'spot-daily'].forEach(updateChartTools);

document.querySelector('#connect-data').addEventListener('click', startLogin);
document.querySelector('#disconnect-data').addEventListener('click', disconnectFyers);
document.querySelector('#notice-connect').addEventListener('click', startLogin);
document.querySelector('#refresh-all').addEventListener('click', loadMarketData);

document.querySelector('#expiry-select').addEventListener('change', async (event) => {
  selectedExpiry = event.target.value;
  const selected = event.target.selectedOptions[0];
  selectedExpiryDate = selected?.textContent || '';
  try {
    const result = await fetchApi(`/api/market/option-chain?${new URLSearchParams({ symbol: SPOT_SYMBOL, strikecount: '25', timestamp: selectedExpiry })}`);
    await updateNearestOptions(result);
  } catch (error) {
    setConnection('Option chain unavailable', false, true);
    showEmpty('call', error.message, true);
    showEmpty('put', error.message, true);
    showNotice(error.message);
  }
});

document.querySelectorAll('[data-contract-nav]').forEach((button) => {
  button.addEventListener('click', () => {
    changeOptionContract(button.dataset.contractNav, Number(button.dataset.direction));
  });
});

document.querySelectorAll('.interval-control select').forEach((select) => {
  select.addEventListener('change', () => {
    const kind = select.dataset.series;
    loadSeries(kind, series[kind].symbol, select.value).catch((error) => showNotice(error.message));
  });
});

refreshConnectionStatus();
