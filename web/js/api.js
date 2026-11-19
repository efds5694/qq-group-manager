// 后端交互封装：统一错误、任务轮询、文件下载

export class ApiError extends Error {
  constructor(message, hint, code) {
    super(message);
    this.name = 'ApiError';
    this.hint = hint || '';
    this.code = code || '';
  }
}

function buildQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    params.set(key, String(value));
  });
  const text = params.toString();
  return text ? `?${text}` : '';
}

async function request(path, { method = 'GET', body, query } = {}) {
  let response;
  try {
    response = await fetch(path + buildQuery(query), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new ApiError('本地服务已断开', '确认黑窗口仍在运行，或重新执行 python run.py。', 'OFFLINE');
  }

  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    if (!response.ok) throw new ApiError(`请求失败（HTTP ${response.status}）`);
    return response;
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ApiError('返回内容解析失败', '可能是服务版本不匹配，重启 python run.py。');
  }
  if (!payload.ok) throw new ApiError(payload.error || '请求失败', payload.hint, payload.code);
  return payload.data;
}

export const get = (path, query) => request(path, { query });
export const post = (path, body) => request(path, { method: 'POST', body: body || {} });
export const del = (path) => request(path, { method: 'DELETE' });

/** 轮询任务直到结束，onTick 每次拿到最新快照 */
export function pollJob(jobId, onTick, intervalMs = 1000, isActive = () => true) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (!isActive()) { resolve(null); return; }
      const started = Date.now();
      try {
        const job = await get(`/api/jobs/${jobId}`);
        if (!isActive()) { resolve(null); return; }
        onTick?.(job);
        if (['done', 'failed', 'canceled'].includes(job.status)) {
          resolve(job);
          return;
        }
        window.setTimeout(tick, Math.max(0, intervalMs - (Date.now() - started)));
      } catch (error) {
        reject(error);
      }
    };
    tick();
  });
}

/** 触发浏览器下载（CSV / XLSX 走这条） */
export function download(path, query) {
  const link = document.createElement('a');
  link.href = path + buildQuery(query);
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** 取纯文本（复制到剪贴板时用，例如 format=tsv） */
export async function getText(path, query) {
  let response;
  try {
    response = await fetch(path + buildQuery(query));
  } catch (error) {
    throw new ApiError('本地服务已断开', '确认黑窗口仍在运行，或重新执行 python run.py。', 'OFFLINE');
  }

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }
    throw new ApiError(payload?.error || `请求失败（HTTP ${response.status}）`, payload?.hint, payload?.code);
  }
  return response.text();
}
