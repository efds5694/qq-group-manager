// 导出弹层（单群 / 多群共用）：字段选择 + 格式 + 复制到剪贴板 + 记住上次配置

import * as api from './api.js';
import { state, loadPrefs, savePrefs } from './state.js';
import { toast, esc, openDrawer, closeDrawer, copyText } from './ui.js';

const PRESET = 'exportPrefs';

function initialPrefs(config) {
  const labels = config?.field_labels || {};
  const all = Object.keys(labels);
  const saved = loadPrefs()[PRESET] || {};
  const formats = config?.formats || ['csv'];

  const savedFields = Array.isArray(saved.fields) ? saved.fields.filter((key) => all.includes(key)) : [];
  const defaultFields = (config?.default_fields || all).filter((key) => all.includes(key));

  return {
    labels,
    all,
    defaultFields,
    fields: savedFields.length ? savedFields : defaultFields,
    formats,
    format: formats.includes(saved.format) ? saved.format : formats[0] || 'csv',
  };
}

/**
 * @param {object} options
 * @param {string} options.title        弹层标题
 * @param {string} options.scopeText    导出范围说明（人话）
 * @param {string} options.basePath     导出接口，例如 /api/export/groups
 * @param {object} options.extraQuery   额外查询参数（groups、q、selected…）
 */
export function openExportDialog({ title = '导出群成员', scopeText = '', basePath, extraQuery = {} }) {
  const config = state.config || {};
  const pref = initialPrefs(config);
  if (!pref.all.length) {
    toast('配置还没加载完成，稍后再试', 'warn');
    return;
  }

  const fieldHtml = pref.all
    .map(
      (key) => `
      <label class="field-option">
        <span class="checkbox">
          <input type="checkbox" data-field="${esc(key)}" ${pref.fields.includes(key) ? 'checked' : ''} />
          <span></span>
        </span>
        <span class="field-name">${esc(pref.labels[key])}</span>
      </label>`
    )
    .join('');

  const formatHtml = pref.formats
    .map(
      (fmt) =>
        `<option value="${esc(fmt)}" ${fmt === pref.format ? 'selected' : ''}>${esc(fmt.toUpperCase())}${
          fmt === 'csv' ? '（Excel 可直接打开）' : ''
        }</option>`
    )
    .join('');

  openDrawer({
    title,
    body: `
      <div class="field">
        <div class="field-head">
          <label>导出字段</label>
          <div class="row" style="gap:6px">
            <button class="btn btn-sm" data-preset="all" type="button">全选</button>
            <button class="btn btn-sm" data-preset="none" type="button">清空</button>
            <button class="btn btn-sm" data-preset="default" type="button">默认</button>
          </div>
        </div>
        <div class="field-options" id="field-options">${fieldHtml}</div>
      </div>
      <div class="field">
        <label>文件格式</label>
        <select class="select" id="export-format">${formatHtml}</select>
      </div>
      <div class="hint-box">
        <span class="hint-icon">i</span>
        <div>
          导出范围：<strong>${esc(scopeText || '当前筛选结果')}</strong>。<br>
          「复制到剪贴板」输出制表符分隔的文本，可以直接粘到 Excel / WPS；
          成员 QQ 号属于个人信息，文件只保存在本机。
        </div>
      </div>`,
    footer: `
      <button class="btn" data-close="1" type="button">取消</button>
      <button class="btn" id="btn-copy" type="button">复制到剪贴板</button>
      <button class="btn btn-primary" id="btn-download" type="button">开始导出</button>`,
    onMount: (panel, foot) => {
      const formatSelect = panel.querySelector('#export-format');
      const copyBtn = foot.querySelector('#btn-copy');
      const downloadBtn = foot.querySelector('#btn-download');

      const pickedFields = () => [...panel.querySelectorAll('[data-field]:checked')].map((node) => node.dataset.field);

      const remember = (fields) => {
        savePrefs({ [PRESET]: { fields, format: formatSelect.value } });
      };

      const check = (fields) => {
        panel.querySelectorAll('[data-field]').forEach((node) => {
          node.checked = fields.includes(node.dataset.field);
        });
      };

      panel.querySelectorAll('[data-preset]').forEach((node) => {
        node.addEventListener('click', () => {
          const kind = node.dataset.preset;
          check(kind === 'all' ? pref.all : kind === 'none' ? [] : pref.defaultFields);
        });
      });

      const busy = (button, text) => {
        button.disabled = true;
        const original = button.textContent;
        button.textContent = text;
        return () => {
          button.disabled = false;
          button.textContent = original;
        };
      };

      downloadBtn.addEventListener('click', () => {
        const fields = pickedFields();
        if (!fields.length) {
          toast('至少选择一个字段', 'warn');
          return;
        }
        remember(fields);
        api.download(basePath, {
          ...extraQuery,
          fields: fields.join(','),
          format: formatSelect.value,
        });
        closeDrawer();
        toast('已开始下载', 'ok');
      });

      copyBtn.addEventListener('click', async () => {
        const fields = pickedFields();
        if (!fields.length) {
          toast('至少选择一个字段', 'warn');
          return;
        }
        const restore = busy(copyBtn, '复制中…');
        try {
          const text = await api.getText(basePath, {
            ...extraQuery,
            fields: fields.join(','),
            format: 'tsv',
          });
          await copyText(text);
          remember(fields);
          const rows = Math.max(0, text.trim().split('\n').length - 1);
          closeDrawer();
          toast(`已复制 ${rows} 行到剪贴板`, 'ok', '制表符分隔，可直接粘贴到 Excel / WPS');
        } catch (error) {
          toast(error.message || '复制失败', 'err', error.hint);
        } finally {
          restore();
        }
      });
    },
  });
}
