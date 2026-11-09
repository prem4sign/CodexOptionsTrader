const UNDERLYINGS = {
  NIFTY: { symbol: 'NSE:NIFTY50-INDEX', label: 'NIFTY 50', shortLabel: 'NIFTY', lotSize: 65 },
  BANKNIFTY: { symbol: 'NSE:NIFTYBANK-INDEX', label: 'BANK NIFTY', shortLabel: 'BANKNIFTY', lotSize: 30 },
};
const underlyingStorageKey = 'options-desk-underlying';
let currentUnderlying = localStorage.getItem(underlyingStorageKey) in UNDERLYINGS
  ? localStorage.getItem(underlyingStorageKey)
  : 'NIFTY';
function spotSymbol() { return UNDERLYINGS[currentUnderlying].symbol; }
function underlyingLabel() { return UNDERLYINGS[currentUnderlying].label; }
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
let newsLoading = false;

const series = {
  call: { symbol: '', interval: '5' },
  put: { symbol: '', interval: '5' },
  'spot-intraday': { symbol: UNDERLYINGS[currentUnderlying].symbol, interval: '60' },
  'spot-daily': { symbol: UNDERLYINGS[currentUnderlying].symbol, interval: '1D' },
};
const chartData = {};
const chartViews = {};
const seriesRequestIds = {};
const workspacesStorageKey = 'options-desk-chart-workspaces';
const defaultEmaSettings = [
  { period: 50, color: '#f59e0b', enabled: true, timeframe: 'chart' },
  { period: 100, color: '#3b82f6', enabled: true, timeframe: 'chart' },
  { period: 200, color: '#000000', enabled: true, timeframe: 'chart' },
];
const emaHistoryCache = new Map();
const emaHistoryRequests = new Map();
const emaTimeframeOptions = [
  ['chart', 'Chart interval'], ['1', '1m'], ['5', '5m'], ['15', '15m'],
  ['30', '30m'], ['60', '1h'], ['1D', '1D'],
];
const chartDrawState = Object.fromEntries(['call', 'put', 'spot-intraday', 'spot-daily'].map((kind) => [kind, {
  emaVisible: true,
  emas: defaultEmaSettings.map((ema) => ({ ...ema })),
  drawTrendline: false,
  extendTrendlineRight: true,
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
  if (!Number.isFinite(price)) throw new Error(`FYERS did not return the ${underlyingLabel()} spot quote.`);
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
  document.querySelector('#spot-eyebrow').textContent = `NSE · ${underlyingLabel()} SPOT`;
  document.querySelectorAll('.spot-title').forEach((node) => { node.textContent = `${underlyingLabel()} Spot`; });
  document.querySelectorAll('.spot-subtitle').forEach((node, index) => {
    node.textContent = `${index === 0 ? 'Spot' : 'Daily'} ${underlyingLabel().toLowerCase()} price · historical OHLC`;
  });
  document.querySelector('#call-subtitle').textContent = `Closest call strike to the current ${underlyingLabel()} spot price`;
  document.querySelector('#put-subtitle').textContent = `Closest put strike to the current ${underlyingLabel()} spot price`;
  document.querySelector('#market-caption').textContent = `${underlyingLabel()} spot from FYERS · option charts use the nearest available strikes.`;
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
  const label = `${UNDERLYINGS[currentUnderlying].shortLabel} ${strike} ${kind === 'call' ? 'CE' : 'PE'}`;
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
  const calendarInterval = ['1D', '1W', '1M'].includes(interval);
  axis.classList.toggle('hour-axis', !calendarInterval);
  axis.classList.toggle('calendar-axis', calendarInterval);
  if (calendarInterval) {
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
  } else {
    const first = Math.max(0, startIndex);
    const last = Math.min(allCandles.length, startIndex + windowSize);
    const hourStarts = [];
    let previousHour = null;
    for (let candleIndex = first; candleIndex < last; candleIndex += 1) {
      const timestamp = allCandles[candleIndex][0];
      const hourBucket = Math.floor((timestamp + 19800) / 3600);
      if (hourBucket === previousHour) continue;
      previousHour = hourBucket;
      hourStarts.push({ candleIndex, timestamp });
    }
    const maxLabels = window.matchMedia('(max-width: 640px)').matches ? 10 : 8;
    const labelStep = Math.max(1, Math.ceil(hourStarts.length / maxLabels));
    const labels = hourStarts.filter((_, index) => index % labelStep === 0).map(({ candleIndex, timestamp }) => {
      const label = document.createElement('span');
      const istDate = new Date((timestamp + 19800) * 1000);
      label.textContent = `${String(istDate.getUTCHours()).padStart(2, '0')}:00`;
      label.style.setProperty('--axis-position', `${((candleIndex - startIndex + 0.5) / windowSize) * 100}%`);
      label.setAttribute('aria-label', formatXAxisLabel(timestamp, interval));
      return label;
    });
    axis.replaceChildren(...labels);
  }
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
  const latestButton = document.querySelector(`[data-chart-latest="${kind}"]`);
  if (latestButton) latestButton.hidden = true;
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

function formatEmaRetouchTime(timestamp, interval) {
  const date = new Date(timestamp * 1000);
  const isCalendarInterval = ['1D', '1W', '1M'].includes(interval);
  return new Intl.DateTimeFormat('en-IN', isCalendarInterval
    ? { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' }
    : { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }).format(date);
}

function emaRetouchPeriod() {
  try {
    const settings = JSON.parse(localStorage.getItem(settingsStorageKey) || 'null');
    const period = Number(settings?.retouchEmaPeriod);
    return [50, 100, 200].includes(period) ? period : 200;
  } catch {
    return 200;
  }
}

function getSpotRetouchEvents() {
  const spotData = chartData['spot-intraday'];
  const spotState = chartDrawState['spot-intraday'];
  const period = emaRetouchPeriod();
  if (!spotData || !spotState.emaVisible) return [];
  const emaSettings = spotState.emas.find((ema) => Number(ema.period) === period);
  if (!emaSettings?.enabled) return [];
  const sourceTimeframe = emaSettings.timeframe || 'chart';
  const resolution = sourceTimeframe === 'chart' ? spotData.interval : sourceTimeframe;
  const sourceCandles = resolution === spotData.interval
    ? spotData.candles
    : emaHistoryCache.get(emaHistoryKey(spotData.symbol, resolution))?.candles;
  if (!sourceCandles?.length) return [];
  const emaValues = projectEmaToChart(sourceCandles, spotData.candles, period, resolution, spotData.interval);
  const events = [];
  for (let index = 0; index < spotData.candles.length; index += 1) {
    const candle = spotData.candles[index];
    const emaValue = emaValues[index];
    if (Number.isFinite(emaValue) && candle[3] <= emaValue && candle[2] >= emaValue) {
      events.push({ timestamp: candle[0], period });
    }
  }
  return events;
}

const retouchChime = new Audio('/DING%20DONG.mp3');
retouchChime.preload = 'auto';
let retouchChimeUnlocked = false;
let retouchSoundContext = '';
let previousSpotRetouches = new Set();
let retouchPollInProgress = false;

function unlockRetouchChime() {
  if (retouchChimeUnlocked) return;
  retouchChime.muted = true;
  const attempt = retouchChime.play();
  if (attempt?.then) {
    attempt.then(() => {
      retouchChime.pause();
      retouchChime.currentTime = 0;
      retouchChime.muted = false;
      retouchChimeUnlocked = true;
    }).catch(() => {
      retouchChime.muted = false;
    });
  }
}

document.addEventListener('pointerdown', unlockRetouchChime, { once: true });

function playRetouchChime() {
  retouchChime.currentTime = 0;
  retouchChime.play().catch(() => {});
}

function observeSpotRetouches(events, spotData) {
  const period = emaRetouchPeriod();
  const emaSettings = chartDrawState['spot-intraday'].emas.find((ema) => Number(ema.period) === period);
  const context = `${spotData.symbol}|${spotData.interval}|${period}|${emaSettings?.timeframe || 'chart'}|${Boolean(emaSettings?.enabled)}`;
  const currentTimestamps = new Set(events.map((event) => event.timestamp));
  if (context !== retouchSoundContext) {
    retouchSoundContext = context;
    previousSpotRetouches = currentTimestamps;
    return;
  }
  const lastTimestamp = spotData.candles[spotData.candles.length - 1]?.[0] || 0;
  const barSeconds = ['1D', '1W', '1M'].includes(spotData.interval)
    ? 86400 : Number(spotData.interval) * 60;
  const recentAfter = lastTimestamp - Math.max(1800, barSeconds * 2);
  const isNewRecentTouch = events.some((event) => (
    event.timestamp >= recentAfter && !previousSpotRetouches.has(event.timestamp)
  ));
  previousSpotRetouches = currentTimestamps;
  if (isNewRecentTouch) playRetouchChime();
}

async function refreshSpotCandlesForRetouch() {
  const kind = 'spot-intraday';
  const data = chartData[kind];
  const state = chartDrawState[kind];
  const period = emaRetouchPeriod();
  const ema = state.emas.find((item) => Number(item.period) === period);
  if (retouchPollInProgress || document.visibilityState !== 'visible'
    || !document.querySelector('#connection-state .status-dot')?.classList.contains('connected')
    || !data || !state.emaVisible || !ema?.enabled
    || ['1D', '1W', '1M'].includes(data.interval)) return;

  retouchPollInProgress = true;
  const { symbol, interval } = data;
  const requestId = seriesRequestIds[kind];
  try {
    const query = new URLSearchParams({ symbol, resolution: interval, include_partial: '1' });
    const payload = await fetchApi(`/api/market/history?${query}`);
    if (seriesRequestIds[kind] !== requestId || series[kind].symbol !== symbol || series[kind].interval !== interval) return;
    drawCandles(kind, payload, symbol, interval);
    redrawOptionRetouchCharts();
  } catch {
    // Keep the last chart visible; the next poll can retry after a transient API error.
  } finally {
    retouchPollInProgress = false;
  }
}

function emaTimeframeLabel(timeframe, chartInterval) {
  const resolution = timeframe === 'chart' ? chartInterval : timeframe;
  if (resolution === '60') return '1h';
  if (resolution === '1D') return '1D';
  return `${resolution}m`;
}

function emaHistoryKey(symbol, timeframe) {
  return `${symbol}|${timeframe}`;
}

function projectEmaToChart(sourceCandles, targetCandles, period, sourceTimeframe, targetTimeframe) {
  const sourceValues = calculateEma(sourceCandles.map((row) => row[4]), period);
  if (sourceTimeframe === targetTimeframe) return targetCandles.map((_, index) => sourceValues[index] ?? null);
  const intervalSeconds = sourceTimeframe === '1D' ? 86400 : Number(sourceTimeframe) * 60;
  let sourceIndex = -1;
  return targetCandles.map((target) => {
    while (sourceIndex + 1 < sourceCandles.length
      && sourceCandles[sourceIndex + 1][0] + intervalSeconds <= target[0]) sourceIndex += 1;
    return sourceIndex >= 0 ? sourceValues[sourceIndex] : null;
  });
}

function ensureEmaHistory(kind, symbol, timeframe) {
  const key = emaHistoryKey(symbol, timeframe);
  const cached = emaHistoryCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < 60000) return;
  if (emaHistoryRequests.has(key)) return;
  const query = new URLSearchParams({ symbol, resolution: timeframe });
  const request = fetchApi(`/api/market/history?${query}`)
    .then((payload) => {
      const candles = (payload.candles || payload.data?.candles || [])
        .filter((row) => Array.isArray(row) && row.length >= 5 && row.slice(0, 5).every((value) => Number.isFinite(Number(value))))
        .map((row) => row.slice(0, 5).map(Number))
        .sort((a, b) => a[0] - b[0]);
      if (!candles.length) throw new Error('No candles were returned for this EMA timeframe.');
      emaHistoryCache.set(key, { candles, fetchedAt: Date.now(), error: '' });
    })
    .catch((error) => {
      emaHistoryCache.set(key, { candles: [], fetchedAt: Date.now(), error: error.message || 'Could not load EMA history.' });
    })
    .finally(() => {
      emaHistoryRequests.delete(key);
      const chart = chartData[kind];
      const stillNeeded = chart?.symbol === symbol && chartDrawState[kind].emaVisible
        && chartDrawState[kind].emas.some((ema) => ema.enabled && ema.timeframe === timeframe && series[kind].interval !== timeframe);
      if (stillNeeded) redrawChart(kind);
    });
  emaHistoryRequests.set(key, request);
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
  const currentPrice = candles[candles.length - 1][4];
  const currentPriceY = y(currentPrice);
  const currentLabelY = Math.max(top + 8, Math.min(bottom - 8, currentPriceY));
  const gap = (right - left) / view.window;
  const width = Math.max(1.4, Math.min(8, gap * 0.58));
  const gridGroup = makeSvgElement('g', { class: 'price-grid' });
  const candleGroup = makeSvgElement('g', { class: 'candle-layer' });
  const emaGroup = makeSvgElement('g', { class: 'ema-layer' });
  emaGroup.style.display = drawState.emaVisible ? '' : 'none';
  const retouchGroup = makeSvgElement('g', { class: 'ema-retouch-markers', 'aria-label': 'Spot EMA retouch markers' });
  const crossGroup = makeSvgElement('g', { class: 'ema-cross-layer', 'aria-label': '100 and 200 EMA crossovers' });
  const trendGroup = makeSvgElement('g', { class: 'trendline-layer', 'clip-path': `url(#trend-clip-${kind})` });
  const currentPriceGroup = makeSvgElement('g', { class: 'current-price-marker', 'aria-label': `Latest price ${formatAxisPrice(currentPrice)}` });
  if (currentPriceY >= top && currentPriceY <= bottom) {
    currentPriceGroup.append(makeSvgElement('line', {
      x1: left, x2: axisLeft - 3, y1: currentPriceY.toFixed(2), y2: currentPriceY.toFixed(2), class: 'current-price-line',
    }));
  }
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
  axisGroup.append(makeSvgElement('rect', {
    x: axisLeft + 2, y: (currentLabelY - 8).toFixed(2), width: 64, height: 16, rx: 2, class: 'current-price-label-bg',
  }));
  const currentLabel = makeSvgElement('text', {
    x: axisTextX, y: (currentLabelY + 3).toFixed(2), class: 'current-price-label', 'text-anchor': 'end',
  });
  currentLabel.textContent = formatAxisPrice(currentPrice);
  axisGroup.append(currentLabel);

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

  const emaValuesByPeriod = new Map();
  for (const [emaIndex, ema] of drawState.emas.entries()) {
    const period = ema.period;
    const emaTimeframe = ema.timeframe || 'chart';
    const sourceTimeframe = emaTimeframe === 'chart' ? interval : emaTimeframe;
    const cacheKey = emaHistoryKey(symbol, sourceTimeframe);
    const cachedHistory = sourceTimeframe === interval
      ? { candles: allCandles, error: '' }
      : emaHistoryCache.get(cacheKey);
    const allValues = cachedHistory?.candles?.length
      ? projectEmaToChart(cachedHistory.candles, allCandles, period, sourceTimeframe, interval)
      : [];
    const values = allValues.slice(firstDataIndex, firstDataIndex + candles.length);
    emaValuesByPeriod.set(Number(period), { values, allValues, enabled: ema.enabled });
    let hasPreviousPoint = false;
    const points = values.map((value, index) => {
      if (!Number.isFinite(value)) {
        hasPreviousPoint = false;
        return '';
      }
      const slot = firstDataIndex - startIndex + index;
      const x = left + (slot + 0.5) * gap;
      const command = `${hasPreviousPoint ? 'L' : 'M'}${x.toFixed(2)},${y(value).toFixed(2)}`;
      hasPreviousPoint = true;
      return command;
    }).filter(Boolean).join(' ');
    const emaPath = makeSvgElement('path', { d: points, class: `ema-line ema-line-${emaIndex}` });
    emaPath.style.stroke = ema.color;
    if (emaIndex === 2 && ema.color.toLowerCase() === '#000000' && document.documentElement.dataset.theme !== 'light') {
      emaPath.style.filter = 'drop-shadow(0 0 1px rgba(255,255,255,.95))';
    }
    emaPath.style.display = ema.enabled ? '' : 'none';
    emaGroup.append(emaPath);
    const valueNode = document.querySelector(`#ema-${kind}-${emaIndex}`);
    const legendNode = document.querySelector(`[data-ema-legend="${kind}-${emaIndex}"]`);
    const latestEmaValue = values[values.length - 1];
    if (valueNode) valueNode.textContent = Number.isFinite(latestEmaValue)
      ? formatNumber(latestEmaValue)
      : cachedHistory?.error ? 'Unavailable' : 'Loading…';
    if (legendNode) {
      legendNode.querySelector('.ema-legend-name').textContent = `EMA ${period} · ${emaTimeframeLabel(emaTimeframe, interval)}`;
      legendNode.querySelector('.ema-swatch').style.backgroundColor = ema.color;
      legendNode.style.display = ema.enabled ? '' : 'none';
    }
  }

  const retouchPeriod = emaRetouchPeriod();
  const retouchEma = emaValuesByPeriod.get(retouchPeriod);
  if (drawState.emaVisible && retouchEma?.enabled
    && kind === 'spot-intraday') {
    observeSpotRetouches(getSpotRetouchEvents(), chartData[kind]);
    let markerNumber = 0;
    const visibleEnd = Math.min(view.end, allCandles.length);
    for (let candleIndex = firstDataIndex; candleIndex < visibleEnd; candleIndex += 1) {
      const candle = allCandles[candleIndex];
      const emaValue = retouchEma.allValues[candleIndex];
      if (!Number.isFinite(emaValue) || candle[3] > emaValue || candle[2] < emaValue) continue;
      const visibleSlot = candleIndex - startIndex;
      if (visibleSlot < 0 || visibleSlot >= view.window) continue;
      const x = left + (visibleSlot + 0.5) * gap;
      const markerY = y(emaValue);
      if (markerY < top || markerY > bottom) continue;
      const marker = makeSvgElement('g', {
        class: 'ema-retouch-marker',
        'aria-label': `${retouchPeriod} EMA touch at ${formatXAxisLabel(candle[0], interval)}`,
      });
      const title = makeSvgElement('title', {});
      title.textContent = `${retouchPeriod} EMA touch · ${formatXAxisLabel(candle[0], interval)}`;
      marker.append(title);
      marker.append(makeSvgElement('path', {
        d: `M${(x - 3).toFixed(2)},${(markerY - 1).toFixed(2)} l2.5,3 l5,-6`,
        class: 'ema-retouch-tick',
      }));
      const alignRight = x > right - 38;
      const alternateLabel = markerNumber % 2 === 1;
      const label = makeSvgElement('text', {
        x: (x + (alignRight ? -5 : 7)).toFixed(2),
        y: (markerY < top + 15 || alternateLabel ? markerY + 11 : markerY - 6).toFixed(2),
        class: 'ema-retouch-time',
        'text-anchor': alignRight ? 'end' : 'start',
      });
      label.textContent = formatEmaRetouchTime(candle[0], interval);
      marker.append(label);
      retouchGroup.append(marker);
      markerNumber += 1;
    }
  }

  if (kind === 'call' || kind === 'put') {
    const optionRetouchEvents = getSpotRetouchEvents();
    const timeTolerance = interval === '1D' ? 36 * 3600
      : interval === '1W' ? 4 * 86400
        : interval === '1M' ? 20 * 86400 : Math.max(120, Number(interval) * 60 * 1.5);
    let markerNumber = 0;
    for (const event of optionRetouchEvents) {
      const candleIndex = nearestCandleIndex(allCandles, event.timestamp);
      const candle = allCandles[candleIndex];
      if (!candle || Math.abs(candle[0] - event.timestamp) > timeTolerance) continue;
      const visibleSlot = candleIndex - startIndex;
      if (visibleSlot < 0 || visibleSlot >= view.window) continue;
      const x = left + (visibleSlot + 0.5) * gap;
      const marker = makeSvgElement('g', {
        class: 'ema-retouch-option-marker',
        'aria-label': `Spot ${event.period} EMA touch at ${formatXAxisLabel(event.timestamp, interval)}`,
      });
      const title = makeSvgElement('title', {});
      title.textContent = `Spot ${event.period} EMA touch · ${formatXAxisLabel(event.timestamp, interval)}`;
      marker.append(title);
      marker.append(makeSvgElement('line', {
        x1: x.toFixed(2), x2: x.toFixed(2), y1: top.toFixed(2), y2: bottom.toFixed(2),
        class: 'ema-retouch-option-line',
      }));
      const tickY = bottom - 4;
      marker.append(makeSvgElement('path', {
        d: `M${(x - 3).toFixed(2)},${(tickY - 1).toFixed(2)} l2.5,3 l5,-6`,
        class: 'ema-retouch-tick',
      }));
      const alignRight = x > right - 38;
      const label = makeSvgElement('text', {
        x: (x + (alignRight ? -5 : 7)).toFixed(2),
        y: (bottom - (markerNumber % 2 ? 13 : 7)).toFixed(2),
        class: 'ema-retouch-time',
        'text-anchor': alignRight ? 'end' : 'start',
      });
      label.textContent = formatEmaRetouchTime(event.timestamp, interval);
      marker.append(label);
      retouchGroup.append(marker);
      markerNumber += 1;
    }
  }

  const fastEma = emaValuesByPeriod.get(100);
  const slowEma = emaValuesByPeriod.get(200);
  if (drawState.emaVisible && fastEma?.enabled && slowEma?.enabled) {
    for (let index = 1; index < Math.min(fastEma.values.length, slowEma.values.length); index += 1) {
      const previousDifference = fastEma.values[index - 1] - slowEma.values[index - 1];
      const currentDifference = fastEma.values[index] - slowEma.values[index];
      if (![previousDifference, currentDifference].every(Number.isFinite)) continue;
      const bullish = previousDifference <= 0 && currentDifference > 0;
      const bearish = previousDifference >= 0 && currentDifference < 0;
      if (!bullish && !bearish) continue;
      const slot = firstDataIndex - startIndex + index;
      const x = left + (slot + 0.5) * gap;
      const crossY = y((fastEma.values[index] + slowEma.values[index]) / 2);
      if (x < left || x > right - 52 || crossY < top || crossY > bottom) continue;
      const marker = makeSvgElement('g', {
        class: `ema-cross-marker ${bullish ? 'ema-cross-bullish' : 'ema-cross-bearish'}`,
        'aria-label': `${bullish ? 'Bullish' : 'Bearish'} 100 EMA crossed ${bullish ? 'above' : 'below'} 200 EMA`,
      });
      const title = makeSvgElement('title', {});
      title.textContent = `${bullish ? 'Bullish' : 'Bearish'} 100 EMA crossed ${bullish ? 'above' : 'below'} 200 EMA`;
      marker.append(title);
      marker.append(makeSvgElement('circle', { cx: x.toFixed(2), cy: crossY.toFixed(2), r: 4, class: 'ema-cross-dot' }));
      const label = makeSvgElement('text', { x: (x + 7).toFixed(2), y: (crossY - 5).toFixed(2), class: 'ema-cross-label' });
      label.textContent = bullish ? '100/200 ↑' : '100/200 ↓';
      marker.append(label);
      crossGroup.append(marker);
    }
  }

  const trendlineMatchesView = (line) => line.symbol === symbol
    && (kind === 'spot-intraday' || line.interval === interval);
  const visibleTrendlines = drawState.trendlines.filter(trendlineMatchesView);
  if (drawState.preview && trendlineMatchesView(drawState.preview)) visibleTrendlines.push(drawState.preview);
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
    const lineEnd = line.extendRight !== false && Math.abs(end.x - start.x) > 0.01
      ? {
        x: Math.max(end.x, right),
        y: start.y + ((end.y - start.y) / (end.x - start.x)) * (Math.max(end.x, right) - start.x),
      }
      : end;
    trendGroup.append(makeSvgElement('line', {
      x1: start.x.toFixed(2), y1: start.y.toFixed(2),
      x2: lineEnd.x.toFixed(2), y2: lineEnd.y.toFixed(2),
      class: line.preview ? 'trend-line trend-line-preview' : 'trend-line',
    }));
  }

  document.querySelector(`#chart-${kind} g`).replaceChildren(definitions, gridGroup, candleGroup, emaGroup, retouchGroup, crossGroup, trendGroup, currentPriceGroup, axisGroup);
  if (drawState.emaVisible) {
    const neededTimeframes = new Set(drawState.emas
      .filter((ema) => ema.enabled)
      .map((ema) => ema.timeframe || 'chart')
      .filter((timeframe) => timeframe !== 'chart' && timeframe !== interval));
    neededTimeframes.forEach((timeframe) => ensureEmaHistory(kind, symbol, timeframe));
  }
  document.querySelector(`[data-chart-card="${kind}"]`).classList.toggle('indicators-hidden', !drawState.emaVisible);
  updateIndicatorLegend(kind);
  document.querySelector(`#empty-${kind}`).hidden = true;
  document.querySelector(`[data-chart-latest="${kind}"]`).hidden = false;
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
    if (kind === 'spot-intraday') redrawOptionRetouchCharts();
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
  if (!currentSpotPrice || !entries.length) throw new Error(`The option chain or ${underlyingLabel()} spot quote is unavailable.`);
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
  const query = new URLSearchParams({ symbol: spotSymbol(), strikecount: '25' });
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
    loadSeries('spot-intraday', spotSymbol(), series['spot-intraday'].interval),
    loadSeries('spot-daily', spotSymbol(), series['spot-daily'].interval),
  ]);
}

async function loadMarketData() {
  if (busy) return;
  busy = true;
  const refreshButton = document.querySelector('#refresh-all');
  refreshButton.disabled = true;
  setConnection('Loading market data');
  document.querySelector('#underlying-select').disabled = true;
  document.querySelector('#market-caption').textContent = `Fetching ${underlyingLabel()} spot, nearest option contracts, and historical candles…`;
  try {
    const [quoteResult, chainResult] = await Promise.allSettled([
      fetchApi(`/api/market/quote?${new URLSearchParams({ symbol: spotSymbol() })}`),
      fetchApi(`/api/market/option-chain?${new URLSearchParams({ symbol: spotSymbol(), strikecount: '25', ...(selectedExpiry ? { timestamp: selectedExpiry } : {}) })}`),
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
    document.querySelector('#underlying-select').disabled = false;
    busy = false;
  }
}

function readSavedWorkspaces() {
  try {
    const value = JSON.parse(localStorage.getItem(workspacesStorageKey) || '[]');
    return Array.isArray(value) ? value.filter((workspace) => workspace && workspace.id && workspace.name) : [];
  } catch {
    return [];
  }
}

function renderSavedWorkspaces(selectedId = document.querySelector('#workspace-select').value) {
  const select = document.querySelector('#workspace-select');
  const workspaces = readSavedWorkspaces().sort((a, b) => a.name.localeCompare(b.name));
  if (workspaces.length) {
    select.replaceChildren(...workspaces.map((workspace) => new Option(workspace.name, workspace.id)));
    select.value = workspaces.some((workspace) => workspace.id === selectedId) ? selectedId : '';
  } else {
    select.replaceChildren(new Option('No saved workspaces', ''));
  }
  const hasSelection = Boolean(select.value);
  document.querySelector('#load-workspace').disabled = !hasSelection;
  document.querySelector('#delete-workspace').disabled = !hasSelection;
}

function captureWorkspace(name, id) {
  const charts = {};
  for (const kind of Object.keys(series)) {
    const view = chartViews[kind];
    charts[kind] = {
      interval: series[kind].interval,
      symbol: series[kind].symbol,
      view: view ? {
        window: view.window,
        end: view.end,
        total: view.total,
        priceScale: view.priceScale,
        priceOffset: view.priceOffset || 0,
      } : null,
      emaVisible: chartDrawState[kind].emaVisible,
      emas: chartDrawState[kind].emas.map((ema) => ({ ...ema })),
      extendTrendlineRight: chartDrawState[kind].extendTrendlineRight,
      trendlines: chartDrawState[kind].trendlines.map((line) => ({ ...line })),
    };
  }
  return {
    id,
    name,
    savedAt: new Date().toISOString(),
    underlying: currentUnderlying,
    expiry: selectedExpiry,
    contracts: { ...optionSymbols },
    charts,
  };
}

function saveWorkspace() {
  const nameInput = document.querySelector('#workspace-name');
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    showNotice('Enter a name for this workspace before saving.');
    return;
  }
  const workspaces = readSavedWorkspaces();
  const existing = workspaces.find((workspace) => workspace.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  const id = existing?.id || (window.crypto?.randomUUID?.() ?? `workspace-${Date.now()}`);
  const workspace = captureWorkspace(name, id);
  const next = existing
    ? workspaces.map((item) => item.id === existing.id ? workspace : item)
    : [...workspaces, workspace];
  try {
    localStorage.setItem(workspacesStorageKey, JSON.stringify(next));
    renderSavedWorkspaces(id);
    showNotice(existing ? `Workspace “${name}” updated.` : `Workspace “${name}” saved.`);
  } catch {
    showNotice('Could not save this workspace in browser storage.');
  }
}

function restoreChartView(kind, savedChart) {
  const data = chartData[kind];
  const savedView = savedChart?.view;
  if (!data || !savedView) return;
  const total = data.candles.length;
  const windowSize = Math.max(1, Math.min(Number(savedView.window) || total, total));
  const wasAtLatest = Number(savedView.end) >= Number(savedView.total);
  const savedEnd = Number(savedView.end) || total;
  const end = wasAtLatest
    ? total
    : Math.max(windowSize, Math.min(total + windowSize - 1, savedEnd));
  chartViews[kind] = {
    window: windowSize,
    end,
    total,
    priceScale: Math.max(0.12, Math.min(12, Number(savedView.priceScale) || 1)),
    priceOffset: Number(savedView.priceOffset) || 0,
  };
}

async function loadWorkspace(workspace) {
  const loadButton = document.querySelector('#load-workspace');
  loadButton.disabled = true;
  try {
    const savedUnderlying = UNDERLYINGS[workspace.underlying] ? workspace.underlying : 'NIFTY';
    currentUnderlying = savedUnderlying;
    localStorage.setItem(underlyingStorageKey, currentUnderlying);
    document.querySelector('#underlying-select').value = currentUnderlying;
    series['spot-intraday'].symbol = spotSymbol();
    series['spot-daily'].symbol = spotSymbol();
    currentSpotPrice = null;
    selectedExpiry = '';
    const savedCharts = workspace.charts || {};
    for (const kind of Object.keys(series)) {
      const select = document.querySelector(`#interval-${kind}`);
      const requestedInterval = savedCharts[kind]?.interval;
      const intervalExists = requestedInterval && [...select.options].some((option) => option.value === requestedInterval);
      if (intervalExists) {
        series[kind].interval = requestedInterval;
        select.value = requestedInterval;
      }
      delete chartViews[kind];
    }

    const requestedExpiry = workspace.expiry || '';
    let expiryFallback = false;
    selectedExpiry = requestedExpiry;
    const quote = await fetchApi(`/api/market/quote?${new URLSearchParams({ symbol: spotSymbol() })}`);
    setSpotQuote(quote);
    try {
      await loadOptionChain(requestedExpiry);
      if (requestedExpiry && selectedExpiry !== requestedExpiry) expiryFallback = true;
    } catch (error) {
      if (!requestedExpiry) throw error;
      selectedExpiry = '';
      await loadOptionChain('');
      expiryFallback = true;
    }

    await loadSpotSeries();
    const missingContract = [];
    await Promise.allSettled(['call', 'put'].map(async (kind) => {
      const savedSymbol = workspace.contracts?.[kind];
      const index = savedSymbol ? optionContracts[kind].findIndex((contract) => contract.symbol === savedSymbol) : -1;
      if (index >= 0 && index !== selectedOptionIndex[kind]) {
        selectedOptionIndex[kind] = index;
        await loadSelectedOption(kind);
      } else if (savedSymbol && index < 0) {
        missingContract.push(kind.toUpperCase());
      }
    }));

    for (const kind of Object.keys(series)) {
      const savedChart = savedCharts[kind] || {};
      chartDrawState[kind].emaVisible = savedChart.emaVisible !== false;
      chartDrawState[kind].emas = Array.isArray(savedChart.emas)
        ? defaultEmaSettings.map((defaults, index) => {
          const saved = savedChart.emas[index] || {};
          return {
            period: Number.isInteger(Number(saved.period)) && Number(saved.period) >= 2 && Number(saved.period) <= 500
              ? Number(saved.period)
              : defaults.period,
            color: /^#[0-9a-f]{6}$/i.test(saved.color || '') ? saved.color : defaults.color,
            enabled: saved.enabled !== false,
            timeframe: emaTimeframeOptions.some(([timeframe]) => timeframe === saved.timeframe) ? saved.timeframe : 'chart',
          };
        })
        : defaultEmaSettings.map((ema) => ({ ...ema }));
      chartDrawState[kind].trendlines = Array.isArray(savedChart.trendlines)
        ? savedChart.trendlines.map((line) => ({ ...line }))
        : [];
      chartDrawState[kind].extendTrendlineRight = savedChart.extendTrendlineRight !== false;
      chartDrawState[kind].drawTrendline = false;
      chartDrawState[kind].preview = null;
      restoreChartView(kind, savedChart);
      updateChartTools(kind);
      redrawChart(kind);
    }

    const notes = [];
    if (expiryFallback) notes.push('saved expiry unavailable; loaded the nearest expiry');
    if (missingContract.length) notes.push(`saved ${missingContract.join('/')} contract unavailable; loaded the nearest strike`);
    showNotice(`Loaded “${workspace.name}”${notes.length ? ` (${notes.join('; ')})` : ''}.`);
  } catch (error) {
    showNotice(`Could not load workspace: ${error.message}`);
  } finally {
    loadButton.disabled = !document.querySelector('#workspace-select').value;
  }
}

function deleteSelectedWorkspace() {
  const select = document.querySelector('#workspace-select');
  const id = select.value;
  const workspace = readSavedWorkspaces().find((item) => item.id === id);
  if (!workspace) return;
  const workspaces = readSavedWorkspaces().filter((item) => item.id !== id);
  try {
    localStorage.setItem(workspacesStorageKey, JSON.stringify(workspaces));
    renderSavedWorkspaces();
    showNotice(`Workspace “${workspace.name}” deleted.`);
  } catch {
    showNotice('Could not delete this workspace.');
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
      setNotice(`Sign in to FYERS to load the ${underlyingLabel()} spot quote, options, and charts.`, true);
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
  retouchEmaPeriod: document.querySelector('#retouch-ema-input'),
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
  if (![50, 100, 200].includes(settings.retouchEmaPeriod)) {
    settingsFields.retouchEmaPeriod.setCustomValidity('Select the 50 EMA, 100 EMA, or 200 EMA.');
    settingsFields.retouchEmaPeriod.reportValidity();
    settingsFields.retouchEmaPeriod.setCustomValidity('');
    return;
  }
  try {
    localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
    settingsStatus.textContent = 'Your trading defaults are saved on this device.';
    renderPaperOrders();
    if (chartData['spot-intraday']) redrawChart('spot-intraday');
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
    const partialButton = document.createElement('button');
    partialButton.type = 'button';
    partialButton.className = 'button order-partial-exit-button';
    partialButton.textContent = 'Partial Exit';
    partialButton.setAttribute('aria-label', `Partially exit paper position ${order.symbol}`);
    partialButton.addEventListener('click', () => partialExitPaperPosition(order.id, partialButton));
    const exitButton = document.createElement('button');
    exitButton.type = 'button';
    exitButton.className = 'button order-exit-button';
    exitButton.textContent = 'Exit position';
    exitButton.setAttribute('aria-label', `Exit paper position ${order.symbol}`);
    exitButton.addEventListener('click', () => exitPaperPosition(order.id, exitButton));
    actions.append(partialButton, exitButton);
  }
  header.append(instrument, actions);

  const metrics = document.createElement('div');
  metrics.className = 'order-metrics';
  const isOpen = order.status === 'OPEN';
  const hasStopLoss = order.stopLossPrice !== null && order.stopLossPrice !== undefined && Number.isFinite(Number(order.stopLossPrice));
  const hasProfitTarget = order.targetPrice !== null && order.targetPrice !== undefined && Number.isFinite(Number(order.targetPrice));
  const pnl = isOpen
    ? Number(order.realizedPnl || 0) + (Number(order.lastPrice || order.entryPrice) - Number(order.entryPrice)) * Number(order.quantity)
    : Number(order.realizedPnl || 0);
  metrics.append(
    createOrderMetric('Quantity', `${formatNumber(order.quantity, 0)} units · ${formatNumber(order.lots, 0)} lot${Number(order.lots) === 1 ? '' : 's'}`),
    createOrderMetric('Entry price', `₹${formatNumber(order.entryPrice)}`),
    createOrderMetric(isOpen ? 'LTP' : 'Exit price', `₹${formatNumber(isOpen ? order.lastPrice || order.entryPrice : order.exitPrice)}`),
    createOrderMetric('Stop loss', hasStopLoss ? `₹${formatNumber(order.stopLossPrice)}` : 'None'),
    createOrderMetric('Profit target', hasProfitTarget ? `₹${formatNumber(order.targetPrice)}` : 'None'),
    createOrderMetric(isOpen ? 'Unrealized P&L' : 'Realized P&L', `${pnl >= 0 ? '+' : '−'}₹${formatNumber(Math.abs(pnl))}`, pnl >= 0 ? 'pnl-positive' : 'pnl-negative'),
  );
  card.append(header, metrics);
  if (isOpen) {
    const triggerActions = document.createElement('div');
    triggerActions.className = 'order-trigger-actions';
    const removeProfitButton = document.createElement('button');
    removeProfitButton.type = 'button';
    removeProfitButton.className = 'button order-trigger-button';
    removeProfitButton.textContent = 'Remove Profit';
    removeProfitButton.disabled = !hasProfitTarget;
    removeProfitButton.addEventListener('click', () => removePaperOrderTrigger(order.id, 'profit'));
    const addProfitButton = document.createElement('button');
    addProfitButton.type = 'button';
    addProfitButton.className = 'button order-trigger-button';
    addProfitButton.textContent = 'Add Profit';
    addProfitButton.disabled = hasProfitTarget;
    addProfitButton.addEventListener('click', () => addPaperOrderTrigger(order.id, 'profit'));
    const removeStopButton = document.createElement('button');
    removeStopButton.type = 'button';
    removeStopButton.className = 'button order-trigger-button';
    removeStopButton.textContent = 'Remove SL';
    removeStopButton.disabled = !hasStopLoss;
    removeStopButton.addEventListener('click', () => removePaperOrderTrigger(order.id, 'stopLoss'));
    const addStopButton = document.createElement('button');
    addStopButton.type = 'button';
    addStopButton.className = 'button order-trigger-button';
    addStopButton.textContent = 'Add SL';
    addStopButton.disabled = hasStopLoss;
    addStopButton.addEventListener('click', () => addPaperOrderTrigger(order.id, 'stopLoss'));
    triggerActions.append(removeStopButton, addStopButton, removeProfitButton, addProfitButton);
    card.append(triggerActions);
  }
  return card;
}

function renderCompletedTradesTable(target, orders) {
  const table = document.createElement('table');
  table.className = 'completed-trades-table';
  table.setAttribute('aria-label', 'Completed paper trades');
  const headers = ['Instrument', 'Order ID', 'Side', 'Realized P&L', 'Type', 'Closed at', 'Status', 'Quantity', 'Entry price', 'Exit price'];
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  headers.forEach((heading) => {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = heading;
    headerRow.append(cell);
  });
  thead.append(headerRow);
  const tbody = document.createElement('tbody');
  for (const order of orders) {
    const row = document.createElement('tr');
    const closedAt = new Date(order.closedAt || order.createdAt);
    const statusText = order.status === 'TARGET' ? 'TARGET HIT'
      : order.status === 'STOP_LOSS' ? 'STOP LOSS'
        : order.exitReason === 'MANUAL' ? 'MANUAL EXIT' : order.status;
    const pnl = Number(order.realizedPnl || 0);
    const values = [
      order.symbol || '—',
      order.id || '—',
      order.side || 'BUY',
      `${pnl >= 0 ? '+' : '−'}₹${formatNumber(Math.abs(pnl))}`,
      order.orderType || 'MARKET',
      Number.isNaN(closedAt.getTime()) ? '—' : closedAt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }),
      statusText,
      `${formatNumber(order.quantity, 0)} units · ${formatNumber(order.lots, 0)} lot${Number(order.lots) === 1 ? '' : 's'}`,
      `₹${formatNumber(order.entryPrice)}`,
      `₹${formatNumber(order.exitPrice)}`,
    ];
    values.forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      if (index === 5) {
        const status = document.createElement('span');
        status.className = 'order-status status-closed';
        status.textContent = value;
        cell.replaceChildren(status);
      }
      if (index === 3) cell.classList.add(pnl >= 0 ? 'pnl-positive' : 'pnl-negative');
      row.append(cell);
    });
    tbody.append(row);
  }
  table.append(thead, tbody);
  target.replaceChildren(table);
}

function removePaperOrderTrigger(orderId, trigger) {
  const orders = readPaperOrders();
  const order = orders.find((item) => item.id === orderId && item.status === 'OPEN');
  if (!order) return;
  if (trigger === 'profit') {
    if (order.targetPrice === null || order.targetPrice === undefined) return;
    order.lastProfitTargetPrice = Number(order.targetPrice);
    order.targetPrice = null;
  } else {
    if (order.stopLossPrice === null || order.stopLossPrice === undefined) return;
    order.lastStopLossPrice = Number(order.stopLossPrice);
    order.stopLossPrice = null;
    order.stopLossEnabled = false;
  }
  savePaperOrders(orders);
  renderPaperOrders();
  showNotice(trigger === 'profit' ? 'Profit target removed from this paper position.' : 'Stop loss removed from this paper position.');
}

function addPaperOrderTrigger(orderId, trigger) {
  const orders = readPaperOrders();
  const order = orders.find((item) => item.id === orderId && item.status === 'OPEN');
  if (!order) return;
  const isProfit = trigger === 'profit';
  const currentValue = isProfit ? order.targetPrice : order.stopLossPrice;
  if (currentValue !== null && currentValue !== undefined) return;
  let settings = {};
  try { settings = JSON.parse(localStorage.getItem(settingsStorageKey) || '{}') || {}; } catch { /* Show the settings prompt below. */ }
  const points = Number(isProfit ? settings.profit : settings.stopLoss);
  if (!Number.isFinite(points) || points <= 0) {
    showNotice(`Set a valid default ${isProfit ? 'profit target' : 'stop loss'} in Trading Settings first.`);
    return;
  }
  const price = Number(order.entryPrice) + (isProfit ? points : -points);
  if (!Number.isFinite(price) || price <= 0) {
    showNotice('The saved point setting produces an invalid trigger price for this order.');
    return;
  }
  if (isProfit) order.targetPrice = price;
  else {
    order.stopLossPrice = price;
    order.stopLossEnabled = true;
  }
  savePaperOrders(orders);
  renderPaperOrders();
  showNotice(`${isProfit ? 'Profit target' : 'Stop loss'} added at ₹${formatNumber(price)} using your saved ${isProfit ? 'profit' : 'stop loss'} points.`);
}

function renderPaperOrders() {
  const orders = readPaperOrders().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const active = orders.filter((order) => order.status === 'OPEN');
  const completed = orders.filter((order) => order.status !== 'OPEN');
  let capital = null;
  try {
    const settings = JSON.parse(localStorage.getItem(settingsStorageKey) || 'null');
    if (Number.isFinite(Number(settings?.capital))) capital = Number(settings.capital);
  } catch { /* Display unavailable capital as a dash. */ }
  const capitalUsed = active.reduce((sum, order) => sum + Number(order.entryPrice) * Number(order.quantity), 0);
  const summaryPnl = orders.reduce((sum, order) => {
    if (order.status === 'OPEN') return sum + Number(order.realizedPnl || 0) + (Number(order.lastPrice || order.entryPrice) - Number(order.entryPrice)) * Number(order.quantity);
    return sum + Number(order.realizedPnl || 0);
  }, 0);
  const setCapitalValue = (id, value) => { document.querySelector(id).textContent = value; };
  setCapitalValue('#paper-total-capital', capital === null ? '—' : `₹${formatNumber(capital)}`);
  setCapitalValue('#paper-capital-used', `₹${formatNumber(capitalUsed)}`);
  setCapitalValue('#paper-capital-remaining', capital === null ? '—' : `₹${formatNumber(capital - capitalUsed)}`);
  const runningPnl = document.querySelector('#paper-running-pnl');
  runningPnl.textContent = `${summaryPnl >= 0 ? '+' : '−'}₹${formatNumber(Math.abs(summaryPnl))}`;
  runningPnl.classList.toggle('pnl-positive', summaryPnl >= 0);
  runningPnl.classList.toggle('pnl-negative', summaryPnl < 0);
  document.querySelector('#orders-summary').textContent = `${active.length} open · ${completed.length} completed`;
  const totalPnl = orders.reduce((sum, order) => {
    if (order.status === 'OPEN') return sum + Number(order.realizedPnl || 0) + (Number(order.lastPrice || order.entryPrice) - Number(order.entryPrice)) * Number(order.quantity);
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
  if (completed.length) renderCompletedTradesTable(completedList, completed.slice(0, 25));
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
    const exitPnl = (exitPrice - Number(order.entryPrice)) * Number(order.quantity);
    order.realizedPnl = Number(order.realizedPnl || 0) + exitPnl;
    order.closedAt = new Date().toISOString();
    order.exitReason = 'MANUAL';
    savePaperOrders(orders);
    addRealizedPnlToCapital(exitPnl);
    renderPaperOrders();
    const result = exitPnl >= 0 ? 'profit' : 'loss';
    showNotice(`Paper position exited at ₹${formatNumber(exitPrice)} · ${result} ₹${formatNumber(Math.abs(exitPnl))}.`);
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Exit position';
    showNotice(error.message || 'Could not exit the paper position.');
  }
}

async function partialExitPaperPosition(orderId, button) {
  const orders = readPaperOrders();
  const order = orders.find((item) => item.id === orderId && item.status === 'OPEN');
  if (!order) return;
  const lotsInput = window.prompt(`How many lots should be exited? Enter 1 to ${order.lots}.`, '1');
  if (lotsInput === null) return;
  const lotsToExit = Number(lotsInput);
  if (!Number.isInteger(lotsToExit) || lotsToExit < 1 || lotsToExit > Number(order.lots)) {
    showNotice(`Enter a whole number of lots from 1 to ${order.lots}.`);
    return;
  }
  button.disabled = true;
  button.textContent = 'Exiting…';
  try {
    const payload = await fetchApi(`/api/market/quote?${new URLSearchParams({ symbol: order.symbol })}`);
    const exitPrice = quotePrice(payload, order.symbol);
    const lotSize = Number(order.lotSize) || Math.round(Number(order.quantity) / Number(order.lots));
    const exitQuantity = lotsToExit * lotSize;
    const exitPnl = (exitPrice - Number(order.entryPrice)) * exitQuantity;
    order.quantity = Number(order.quantity) - exitQuantity;
    order.lots = Number(order.lots) - lotsToExit;
    order.lastPrice = exitPrice;
    order.realizedPnl = Number(order.realizedPnl || 0) + exitPnl;
    order.lastPartialExitAt = new Date().toISOString();
    order.lastPartialExitPrice = exitPrice;
    if (order.lots === 0) {
      order.status = 'EXITED';
      order.exitPrice = exitPrice;
      order.closedAt = order.lastPartialExitAt;
      order.exitReason = 'MANUAL';
    }
    savePaperOrders(orders);
    addRealizedPnlToCapital(exitPnl);
    renderPaperOrders();
    showNotice(`${lotsToExit} lot${lotsToExit === 1 ? '' : 's'} exited at ₹${formatNumber(exitPrice)} · ${exitPnl >= 0 ? 'profit' : 'loss'} ₹${formatNumber(Math.abs(exitPnl))}.`);
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Partial Exit';
    showNotice(error.message || 'Could not partially exit the paper position.');
  }
}

async function buyPaperOption(kind, withStopLoss = true) {
  const button = withStopLoss
    ? document.querySelector(`[data-paper-buy="${kind}"]`)
    : document.querySelector(`[data-paper-buy-without-sl="${kind}"]`);
  const settings = (() => {
    try { return JSON.parse(localStorage.getItem(settingsStorageKey) || 'null'); } catch { return null; }
  })();
  if (!settings || !settings.capital || !settings.lots || !settings.profit || (withStopLoss && !settings.stopLoss)) {
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
  const stopLossPoints = withStopLoss ? Number(settings.stopLoss) : null;
  if (!(capital > 0) || !Number.isInteger(lots) || lots < 1 || !(profitPoints > 0) || (withStopLoss && !(stopLossPoints > 0))) {
    showAppView('settings');
    showNotice('Check and save valid trading settings before placing an order.');
    return;
  }

  button.disabled = true;
  button.textContent = 'Buying…';
  try {
    const payload = await fetchApi(`/api/market/quote?${new URLSearchParams({ symbol })}`);
    const entryPrice = quotePrice(payload, symbol);
    const lotSize = Number(optionContracts[kind][selectedOptionIndex[kind]]?.lot_size)
      || Number(optionContracts[kind][selectedOptionIndex[kind]]?.lotSize)
      || UNDERLYINGS[currentUnderlying].lotSize;
    const quantity = lots * lotSize;
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
      lotSize,
      quantity,
      entryPrice,
      lastPrice: entryPrice,
      stopLossPrice: withStopLoss ? entryPrice - stopLossPoints : null,
      targetPrice: entryPrice + profitPoints,
      stopLossEnabled: withStopLoss,
      createdAt: now.toISOString(),
    };
    orders.unshift(order);
    savePaperOrders(orders);
    renderPaperOrders();
    showNotice(`Paper buy${withStopLoss ? '' : ' without stop loss'} filled: ${symbol} · ${quantity} units at ₹${formatNumber(entryPrice)}.`);
  } catch (error) {
    showNotice(error.message);
  } finally {
    button.disabled = false;
    button.textContent = withStopLoss ? 'Buy' : 'Buy without SL';
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
        if (order.stopLossPrice !== null && order.stopLossPrice !== undefined && price <= Number(order.stopLossPrice)) {
          order.status = 'STOP_LOSS';
          order.exitPrice = price;
          const finalPnl = (price - Number(order.entryPrice)) * Number(order.quantity);
          order.realizedPnl = Number(order.realizedPnl || 0) + finalPnl;
          capitalAdjustment += finalPnl;
          order.closedAt = new Date().toISOString();
          completedNow.push(`${order.symbol} reached stop loss.`);
        } else if (order.targetPrice !== null && order.targetPrice !== undefined && price >= Number(order.targetPrice)) {
          order.status = 'TARGET';
          order.exitPrice = Number(order.targetPrice);
          const finalPnl = (Number(order.targetPrice) - Number(order.entryPrice)) * Number(order.quantity);
          order.realizedPnl = Number(order.realizedPnl || 0) + finalPnl;
          capitalAdjustment += finalPnl;
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
  for (const kind of Object.keys(chartDrawState)) {
    if (chartData[kind]) redrawChart(kind);
    else updateIndicatorLegend(kind);
  }
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

function verdictForNews(items) {
  const counts = { Upside: 0, Downside: 0, Mixed: 0 };
  for (const item of items) {
    if (item.direction === 'Upside') counts.Upside += 1;
    else if (item.direction === 'Downside') counts.Downside += 1;
    else counts.Mixed += 1;
  }
  const directional = counts.Upside + counts.Downside;
  const balance = directional ? (counts.Upside - counts.Downside) / directional : 0;
  const label = directional < 2 || Math.abs(balance) < 0.16
    ? 'Mixed / unclear news bias'
    : balance > 0 ? 'Positive news bias' : 'Negative news bias';
  const color = label.startsWith('Positive') ? 'impact-up' : label.startsWith('Negative') ? 'impact-down' : 'impact-mixed';
  const detail = `${counts.Upside} positive · ${counts.Downside} negative · ${counts.Mixed} mixed headlines`;
  return { label, color, detail };
}

function renderVerdict(items, error = '') {
  const underlying = currentUnderlying === 'BANKNIFTY' ? 'BANK NIFTY' : 'NIFTY';
  const filtered = (Array.isArray(items) ? items : []).filter((item) =>
    !Array.isArray(item.indices) || item.indices.includes(underlying) || item.indices.includes('BANK NIFTY') && underlying === 'BANK NIFTY',
  );
  document.querySelector('#verdict-subtitle').textContent = `Headline sentiment for ${underlying}. Use the charts and your own risk rules alongside this view.`;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayItems = filtered.filter((item) => {
    const published = new Date(item.publishedAt).getTime();
    return Number.isFinite(published) && published >= todayStart && published <= now.getTime();
  });
  const recentItems = filtered.filter((item) => {
    const published = new Date(item.publishedAt).getTime();
    return Number.isFinite(published) && published >= now.getTime() - 7 * 24 * 60 * 60 * 1000 && published <= now.getTime();
  });
  const today = verdictForNews(todayItems);
  const nextDays = verdictForNews(recentItems);
  document.querySelector('#verdict-today-title').textContent = todayItems.length ? today.label : error ? 'News unavailable' : 'No clear signal';
  document.querySelector('#verdict-today-detail').textContent = todayItems.length ? `${today.detail} since midnight. Headline tone only.` : error || 'No relevant headlines published today.';
  document.querySelector('#verdict-days-title').textContent = recentItems.length ? nextDays.label : error ? 'News unavailable' : 'No clear signal';
  document.querySelector('#verdict-days-detail').textContent = recentItems.length ? `${nextDays.detail} over the past 7 days. Recent themes may persist, but new events can change the picture.` : error || 'Not enough recent headlines to form a broad read.';
  document.querySelector('#verdict-today-title').className = `verdict-heading ${today.color}`;
  document.querySelector('#verdict-days-title').className = `verdict-heading ${nextDays.color}`;
  const list = document.querySelector('#verdict-drivers-list');
  const drivers = [...filtered].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).slice(0, 3);
  if (!drivers.length) {
    const empty = document.createElement('li');
    empty.className = 'news-status';
    empty.textContent = error || 'No relevant headlines were returned. Try Refresh later.';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...drivers.map((item) => {
    const row = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'news-headline';
    link.textContent = item.title || 'Untitled headline';
    try {
      const url = new URL(item.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
    } catch { /* Keep invalid feed URLs as plain headline text. */ }
    const meta = document.createElement('span');
    meta.className = 'news-source';
    const published = new Date(item.publishedAt);
    const date = Number.isNaN(published.getTime()) ? '' : new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(published);
    meta.textContent = [item.source || 'News source', date].filter(Boolean).join(' · ');
    row.append(link, meta);
    return row;
  }));
}

async function loadLatestNews(force = false) {
  if (newsLoading) return;
  newsLoading = true;
  const refresh = document.querySelector('#refresh-news');
  const updated = document.querySelector('#news-updated');
  refresh.disabled = true;
  refresh.textContent = 'Loading…';
  updated.textContent = 'Summarizing recent headlines…';
  try {
    const result = await fetchApi(`/api/news${force ? '?refresh=1' : ''}`);
    renderVerdict(result.items || [], result.error || '');
    const stamp = result.fetchedAt ? new Date(result.fetchedAt) : new Date();
    updated.textContent = `Updated ${new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(stamp)} IST · Based on ${result.items?.length || 0} recent headlines`;
  } catch (error) {
    renderVerdict([], `Could not load news: ${error.message}`);
    updated.textContent = 'Check your internet connection and try Refresh.';
  } finally {
    refresh.disabled = false;
    refresh.textContent = 'Refresh';
    newsLoading = false;
  }
}

function showAppView(view) {
  const workspaceOpen = view === 'workspace';
  document.querySelector('#workspace-view').hidden = !workspaceOpen;
  document.querySelector('#settings-view').hidden = view !== 'settings';
  document.querySelector('#orders-view').hidden = view !== 'orders';
  document.querySelector('#news-view').hidden = view !== 'news';
  document.querySelector('#workspace-actions').hidden = !workspaceOpen;
  document.querySelector('#settings-actions').hidden = workspaceOpen;
  window.scrollTo(0, 0);
}
document.querySelector('#open-settings').addEventListener('click', () => showAppView('settings'));
document.querySelector('#back-to-workspace').addEventListener('click', () => showAppView('workspace'));
document.querySelector('#open-news').addEventListener('click', async () => {
  showAppView('news');
  await loadLatestNews();
});
document.querySelector('#refresh-news').addEventListener('click', () => loadLatestNews(true));
document.querySelector('#open-orders').addEventListener('click', () => {
  renderPaperOrders();
  showAppView('orders');
  refreshPaperOrders();
});
document.querySelector('#refresh-orders').addEventListener('click', refreshPaperOrders);
document.querySelector('#clear-order-history').addEventListener('click', () => {
  if (refreshingPaperQuotes) {
    showNotice('Wait for the order refresh to finish before clearing history.');
    return;
  }
  if (!readPaperOrders().length) {
    showNotice('There are no paper trades to clear.');
    return;
  }
  const confirmed = window.confirm(
    'Clear all open positions and completed trades from this browser? This cannot be undone. Saved trading capital will remain unchanged.',
  );
  if (!confirmed) return;
  try {
    savePaperOrders([]);
    renderPaperOrders();
    showNotice('All open positions and completed trades were cleared. Saved trading capital is unchanged.');
  } catch {
    showNotice('Could not clear paper trade history in this browser.');
  }
});
document.querySelectorAll('[data-paper-buy]').forEach((button) => {
  button.addEventListener('click', () => buyPaperOption(button.dataset.paperBuy));
});
document.querySelectorAll('[data-paper-buy-without-sl]').forEach((button) => {
  button.addEventListener('click', () => buyPaperOption(button.dataset.paperBuyWithoutSl, false));
});
renderPaperOrders();
window.setInterval(refreshPaperOrders, 15000);

function redrawChart(kind) {
  const data = chartData[kind];
  if (data) {
    drawCandles(kind, data.payload, data.symbol, data.interval);
    if (kind === 'spot-intraday') redrawOptionRetouchCharts();
  }
}

function redrawOptionRetouchCharts() {
  redrawChart('call');
  redrawChart('put');
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

function goToLatestCandles(kind) {
  const view = chartViews[kind];
  if (!chartData[kind] || !view) return;
  view.end = view.total;
  redrawChart(kind);
}

document.querySelectorAll('[data-chart-zoom]').forEach((button) => {
  button.addEventListener('click', () => zoomChart(button.dataset.chartZoom, button.dataset.action));
});
document.querySelectorAll('[data-chart-latest]').forEach((button) => {
  button.addEventListener('click', () => goToLatestCandles(button.dataset.chartLatest));
});

function updateChartTools(kind) {
  const drawState = chartDrawState[kind];
  const trendButton = document.querySelector(`[data-trendline-toggle="${kind}"]`);
  trendButton.textContent = drawState.drawTrendline ? 'Cancel line' : '↗ Line';
  trendButton.classList.toggle('is-active', drawState.drawTrendline);
  trendButton.setAttribute('aria-pressed', String(drawState.drawTrendline));
  const extendButton = document.querySelector(`[data-trendline-extend="${kind}"]`);
  extendButton.classList.toggle('is-active', drawState.extendTrendlineRight);
  extendButton.setAttribute('aria-pressed', String(drawState.extendTrendlineRight));
  extendButton.textContent = drawState.extendTrendlineRight ? '→ Right' : 'Right off';
  document.querySelector(`[data-trendline-clear="${kind}"]`).disabled = drawState.trendlines.length === 0;
  document.querySelector(`#chart-${kind}`).classList.toggle('draw-mode', drawState.drawTrendline);
}

function updateIndicatorLegend(kind) {
  const drawState = chartDrawState[kind];
  for (const [index, ema] of drawState.emas.entries()) {
    const legend = document.querySelector(`[data-ema-legend="${kind}-${index}"]`);
    if (!legend) continue;
    legend.style.display = drawState.emaVisible && ema.enabled ? '' : 'none';
    legend.querySelector('.ema-legend-name').textContent = `EMA ${ema.period} · ${emaTimeframeLabel(ema.timeframe || 'chart', series[kind].interval)}`;
    const swatch = legend.querySelector('.ema-swatch');
    swatch.style.backgroundColor = ema.color;
    swatch.style.boxShadow = index === 2 && ema.color.toLowerCase() === '#000000'
      && document.documentElement.dataset.theme !== 'light' ? '0 0 0 1px #d7e1ed' : '';
  }
}

function createIndicatorDialog(kind) {
  const dialog = document.createElement('dialog');
  dialog.className = 'indicator-dialog';
  dialog.setAttribute('aria-labelledby', `indicator-dialog-title-${kind}`);

  const panel = document.createElement('div');
  panel.className = 'indicator-dialog-panel';
  const heading = document.createElement('header');
  heading.className = 'indicator-dialog-heading';
  const title = document.createElement('h2');
  title.id = `indicator-dialog-title-${kind}`;
  const chartNames = {
    call: `${UNDERLYINGS[currentUnderlying].shortLabel} CE`,
    put: `${UNDERLYINGS[currentUnderlying].shortLabel} PE`,
    'spot-intraday': `${underlyingLabel()} spot intraday`,
    'spot-daily': `${underlyingLabel()} spot daily`,
  };
  title.textContent = `Indicator settings · ${chartNames[kind]}`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'indicator-dialog-close';
  close.setAttribute('aria-label', 'Close indicator settings');
  close.textContent = '×';
  close.addEventListener('click', () => dialog.close());
  heading.append(title, close);
  panel.append(heading);

  const showRow = document.createElement('label');
  showRow.className = 'indicator-global-toggle';
  const show = document.createElement('input');
  show.type = 'checkbox';
  show.dataset.showAllEmas = '';
  const showText = document.createElement('span');
  showText.textContent = 'Show EMA';
  showRow.append(show, showText);
  panel.append(showRow);

  const rows = document.createElement('div');
  rows.className = 'ema-settings-list';
  for (let index = 0; index < defaultEmaSettings.length; index += 1) {
    const row = document.createElement('div');
    row.className = 'ema-settings-row';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.dataset.emaEnabled = String(index);
    enabled.setAttribute('aria-label', `Enable EMA ${index + 1}`);
    const name = document.createElement('span');
    name.textContent = 'EMA';
    const period = document.createElement('input');
    period.type = 'number';
    period.min = '2';
    period.max = '500';
    period.step = '1';
    period.dataset.emaPeriod = String(index);
    period.setAttribute('aria-label', `EMA ${index + 1} period`);
    const timeframe = document.createElement('select');
    timeframe.dataset.emaTimeframe = String(index);
    timeframe.setAttribute('aria-label', `EMA ${index + 1} timeframe`);
    emaTimeframeOptions.forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      timeframe.append(option);
    });
    const color = document.createElement('input');
    color.type = 'color';
    color.dataset.emaColor = String(index);
    color.setAttribute('aria-label', `EMA ${index + 1} color`);
    row.append(enabled, name, period, timeframe, color);
    rows.append(row);
  }
  panel.append(rows);

  const actions = document.createElement('div');
  actions.className = 'indicator-dialog-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button button-secondary';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => dialog.close());
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'button button-primary';
  apply.textContent = 'Apply';
  apply.addEventListener('click', () => {
    const nextSettings = [];
    for (let index = 0; index < defaultEmaSettings.length; index += 1) {
      const period = panel.querySelector(`[data-ema-period="${index}"]`);
      const value = Number(period.value);
      if (!Number.isInteger(value) || value < 2 || value > 500) {
        period.setCustomValidity('Enter a whole number from 2 to 500.');
        period.reportValidity();
        period.setCustomValidity('');
        return;
      }
      nextSettings.push({
        period: value,
        color: panel.querySelector(`[data-ema-color="${index}"]`).value,
        enabled: panel.querySelector(`[data-ema-enabled="${index}"]`).checked,
        timeframe: panel.querySelector(`[data-ema-timeframe="${index}"]`).value,
      });
    }
    chartDrawState[kind].emaVisible = show.checked;
    chartDrawState[kind].emas = nextSettings;
    updateIndicatorLegend(kind);
    redrawChart(kind);
    dialog.close();
    showNotice('Indicator settings applied. Save the workspace to keep them there.');
  });
  actions.append(cancel, apply);
  panel.append(actions);
  dialog.append(panel);
  dialog.addEventListener('close', () => {
    document.querySelector(`[data-indicator-settings="${kind}"]`).setAttribute('aria-expanded', 'false');
  });
  document.body.append(dialog);
  return dialog;
}

function openIndicatorSettings(kind, button) {
  let dialog = document.querySelector(`#indicator-settings-${kind}`);
  if (!dialog) {
    dialog = createIndicatorDialog(kind);
    dialog.id = `indicator-settings-${kind}`;
  }
  const state = chartDrawState[kind];
  dialog.querySelector('[data-show-all-emas]').checked = state.emaVisible;
  for (const [index, ema] of state.emas.entries()) {
    dialog.querySelector(`[data-ema-enabled="${index}"]`).checked = ema.enabled;
    dialog.querySelector(`[data-ema-period="${index}"]`).value = String(ema.period);
    dialog.querySelector(`[data-ema-color="${index}"]`).value = ema.color;
    dialog.querySelector(`[data-ema-timeframe="${index}"]`).value = ema.timeframe || 'chart';
  }
  button.setAttribute('aria-expanded', 'true');
  dialog.showModal();
}

document.querySelectorAll('[data-indicator-settings]').forEach((button) => {
  button.addEventListener('click', () => {
    openIndicatorSettings(button.dataset.indicatorSettings, button);
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

document.querySelectorAll('[data-trendline-extend]').forEach((button) => {
  button.addEventListener('click', () => {
    const kind = button.dataset.trendlineExtend;
    chartDrawState[kind].extendTrendlineRight = !chartDrawState[kind].extendTrendlineRight;
    updateChartTools(kind);
    showNotice(chartDrawState[kind].extendTrendlineRight
      ? 'New trend lines will extend to the right edge.'
      : 'New trend lines will end at the second point.');
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

function trendlineHitTest(kind, svg, event) {
  const data = chartData[kind];
  const view = chartViews[kind];
  if (!data || !view) return null;
  const drawState = chartDrawState[kind];
  const bounds = svg.getBoundingClientRect();
  const pointer = {
    x: ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) * 760,
    y: ((event.clientY - bounds.top) / Math.max(bounds.height, 1)) * 180,
  };
  const left = 4;
  const right = 675;
  const top = 6;
  const bottom = 174;
  const startIndex = view.end - view.window;
  const visible = data.candles.slice(Math.max(0, startIndex), Math.min(view.end, data.candles.length));
  if (!visible.length) return null;
  const low = Math.min(...visible.map((row) => row[3]));
  const high = Math.max(...visible.map((row) => row[2]));
  const mid = (low + high) / 2 + (view.priceOffset || 0);
  const span = Math.max(high - low, Math.abs(high) * 0.0001, 0.01) * (view.priceScale || 1);
  const y = (price) => bottom - ((price - (mid - span / 2)) / span) * (bottom - top);
  const gap = (right - left) / view.window;
  let nearest = null;
  let nearestDistance = 9;
  const matches = (line) => line.symbol === data.symbol && (kind === 'spot-intraday' || line.interval === data.interval);
  for (const [index, line] of drawState.trendlines.entries()) {
    if (!matches(line)) continue;
    const first = nearestCandleIndex(data.candles, line.start.timestamp);
    const last = nearestCandleIndex(data.candles, line.end.timestamp);
    const firstVisible = first - startIndex;
    const lastVisible = last - startIndex;
    const a = { x: left + (firstVisible + 0.5) * gap, y: y(line.start.price) };
    const b = { x: left + (lastVisible + 0.5) * gap, y: y(line.end.price) };
    const end = line.extendRight !== false && Math.abs(b.x - a.x) > 0.01
      ? { x: Math.max(b.x, right), y: a.y + ((b.y - a.y) / (b.x - a.x)) * (Math.max(b.x, right) - a.x) }
      : b;
    const dx = end.x - a.x;
    const dy = end.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const projection = lengthSquared ? Math.max(0, Math.min(1, ((pointer.x - a.x) * dx + (pointer.y - a.y) * dy) / lengthSquared)) : 0;
    const distance = Math.hypot(pointer.x - (a.x + projection * dx), pointer.y - (a.y + projection * dy));
    if (distance < nearestDistance && pointer.x >= left && pointer.x <= right && pointer.y >= top && pointer.y <= bottom) {
      nearest = { index, line, distance };
      nearestDistance = distance;
    }
  }
  return nearest;
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
      const hit = trendlineHitTest(kind, svg, event);
      if (hit) {
        const start = chartPointFromEvent(kind, svg, event);
        dragStart = {
          mode: 'trendline-move', lineIndex: hit.index, start,
          originalStart: { ...hit.line.start }, originalEnd: { ...hit.line.end },
        };
      } else {
        dragStart = { mode: 'pan', x: event.clientX, y: event.clientY, end: view.end, priceOffset: view.priceOffset || 0, priceSpan: view.priceSpan || 1 };
      }
    }
    svg.classList.add('is-dragging');
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', (event) => {
    if (!dragStart) {
      svg.classList.toggle('trendline-hover', !chartDrawState[kind].drawTrendline && Boolean(trendlineHitTest(kind, svg, event)));
      return;
    }
    const view = chartViews[kind];
    if (!view) return;
    if (dragStart.mode === 'price-scale') {
      const verticalChange = event.clientY - dragStart.y;
      view.priceScale = Math.max(0.12, Math.min(12, dragStart.priceScale * Math.exp(verticalChange * 0.012)));
    } else if (dragStart.mode === 'trendline') {
      const end = chartPointFromEvent(kind, svg, event);
      if (end && chartDrawState[kind].preview) chartDrawState[kind].preview.end = end;
    } else if (dragStart.mode === 'trendline-move') {
      const point = chartPointFromEvent(kind, svg, event);
      const line = chartDrawState[kind].trendlines[dragStart.lineIndex];
      if (point && line) {
        const timeDelta = point.timestamp - dragStart.start.timestamp;
        const priceDelta = point.price - dragStart.start.price;
        line.start = { timestamp: dragStart.originalStart.timestamp + timeDelta, price: dragStart.originalStart.price + priceDelta };
        line.end = { timestamp: dragStart.originalEnd.timestamp + timeDelta, price: dragStart.originalEnd.price + priceDelta };
      }
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
          extendRight: drawState.extendTrendlineRight,
        });
        showNotice(kind === 'spot-intraday'
          ? 'Trend line added at its price and time position. It will stay anchored across intervals.'
          : 'Trend line added. Use Clear to remove it.');
      }
      drawState.preview = null;
      drawState.drawTrendline = false;
      updateChartTools(kind);
      redrawChart(kind);
    } else if (dragStart?.mode === 'trendline-move') {
      const line = chartDrawState[kind].trendlines[dragStart.lineIndex];
      if (cancelled && line) {
        line.start = dragStart.originalStart;
        line.end = dragStart.originalEnd;
      } else if (line) showNotice('Trend line moved. Save the workspace to keep this change.');
      redrawChart(kind);
    }
    dragStart = null;
    svg.classList.remove('is-dragging');
    svg.classList.remove('trendline-hover');
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
document.querySelector('#underlying-select').value = currentUnderlying;
document.querySelectorAll('.spot-title').forEach((node) => { node.textContent = `${underlyingLabel()} Spot`; });
document.querySelector('#spot-eyebrow').textContent = `NSE · ${underlyingLabel()} SPOT`;
document.querySelector('#underlying-select').addEventListener('change', async (event) => {
  const nextUnderlying = event.target.value;
  if (!UNDERLYINGS[nextUnderlying] || busy) return;
  currentUnderlying = nextUnderlying;
  localStorage.setItem(underlyingStorageKey, currentUnderlying);
  selectedExpiry = '';
  selectedExpiryDate = '';
  currentSpotPrice = null;
  optionSymbols = { call: '', put: '' };
  optionContracts = { call: [], put: [] };
  selectedOptionIndex = { call: -1, put: -1 };
  series['spot-intraday'].symbol = spotSymbol();
  series['spot-daily'].symbol = spotSymbol();
  document.querySelector('#spot-price').textContent = '—';
  document.querySelector('#spot-change').textContent = 'Loading quote';
  document.querySelectorAll('.spot-title').forEach((node) => { node.textContent = `${underlyingLabel()} Spot`; });
  document.querySelectorAll('.spot-subtitle').forEach((node, index) => {
    node.textContent = `${index === 0 ? 'Spot' : 'Daily'} ${underlyingLabel().toLowerCase()} price · historical OHLC`;
  });
  document.querySelector('#spot-eyebrow').textContent = `NSE · ${underlyingLabel()} SPOT`;
  document.querySelector('#expiry-select').replaceChildren(new Option('Loading expiries…', ''));
  document.querySelector('#expiry-select').disabled = true;
  for (const kind of ['call', 'put']) showEmpty(kind, 'Loading option contracts…');
  for (const kind of ['spot-intraday', 'spot-daily']) showEmpty(kind, 'Loading index candles…');
  await loadMarketData();
});
document.querySelector('#save-workspace').addEventListener('click', saveWorkspace);
document.querySelector('#workspace-select').addEventListener('change', (event) => {
  const workspace = readSavedWorkspaces().find((item) => item.id === event.target.value);
  document.querySelector('#workspace-name').value = workspace?.name || '';
  renderSavedWorkspaces(event.target.value);
});
document.querySelector('#load-workspace').addEventListener('click', () => {
  const workspace = readSavedWorkspaces().find((item) => item.id === document.querySelector('#workspace-select').value);
  if (workspace) loadWorkspace(workspace);
});
document.querySelector('#delete-workspace').addEventListener('click', deleteSelectedWorkspace);
renderSavedWorkspaces('');

document.querySelector('#expiry-select').addEventListener('change', async (event) => {
  selectedExpiry = event.target.value;
  const selected = event.target.selectedOptions[0];
  selectedExpiryDate = selected?.textContent || '';
  try {
    const result = await fetchApi(`/api/market/option-chain?${new URLSearchParams({ symbol: spotSymbol(), strikecount: '25', timestamp: selectedExpiry })}`);
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
window.setInterval(refreshSpotCandlesForRetouch, 60000);
