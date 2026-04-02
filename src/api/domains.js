/**
 * 域名管理 API 模块
 * 控制哪些域名可用于创建临时邮箱
 * @module api/domains
 */

import { isStrictAdmin, errorResponse } from './helpers.js';
import { normalizeDomain } from '../utils/common.js';

/**
 * 处理域名管理相关 API（仅管理员可操作）
 * @param {Request} request
 * @param {object} db
 * @param {Array<string>} mailDomains - 环境变量中配置的域名列表
 * @param {URL} url
 * @param {string} path
 * @param {object} options
 * @returns {Promise<Response|null>}
 */
export async function handleDomainsApi(request, db, mailDomains, url, path, options) {
  // 域名管理仅允许严格管理员
  if (!isStrictAdmin(request, options)) return null;

  const configDomains = (Array.isArray(mailDomains) ? mailDomains : [])
    .map(normalizeDomain)
    .filter(Boolean);

  // GET /api/admin/domains — 获取所有域名及其启用状态（按 sort_order 排序）
  if (path === '/api/admin/domains' && request.method === 'GET') {
    try {
      const { results: dbRows } = await db.prepare(
        'SELECT domain, enabled, sort_order FROM domains ORDER BY sort_order ASC, id ASC'
      ).all();

      const dbMap = new Map((dbRows || []).map(r => [r.domain, r]));

      // 未在数据库中出现的域名，根据 configDomains 的原始顺序放到末尾
      const dbDomains = (dbRows || []).map(r => r.domain).filter(d => configDomains.includes(d));
      const newDomains = configDomains.filter(d => !dbMap.has(d));
      const orderedDomains = [...dbDomains, ...newDomains];

      const list = orderedDomains.map(domain => ({
        domain,
        enabled: dbMap.has(domain) ? !!dbMap.get(domain).enabled : true,
        sort_order: dbMap.has(domain) ? dbMap.get(domain).sort_order : 9999
      }));

      return Response.json(list);
    } catch (e) {
      return errorResponse('查询失败', 500);
    }
  }

  // POST /api/admin/domains/toggle — 切换域名启用状态
  if (path === '/api/admin/domains/toggle' && request.method === 'POST') {
    try {
      const body = await request.json();
      const domain = normalizeDomain(body.domain || '');
      if (!domain) return errorResponse('缺少域名参数', 400);

      if (!configDomains.includes(domain)) {
        return errorResponse('域名不在配置列表中', 400);
      }

      const enabled = body.enabled ? 1 : 0;

      await db.prepare(`
        INSERT INTO domains (domain, enabled, sort_order) VALUES (?, ?, 0)
        ON CONFLICT(domain) DO UPDATE SET enabled = excluded.enabled
      `).bind(domain, enabled).run();

      return Response.json({ success: true, domain, enabled: !!enabled });
    } catch (e) {
      return errorResponse('操作失败: ' + (e?.message || e), 500);
    }
  }

  // POST /api/admin/domains/reorder — 保存拖拽排序结果
  if (path === '/api/admin/domains/reorder' && request.method === 'POST') {
    try {
      const body = await request.json();
      // body.order: string[] — 排序后的域名数组，索引即为 sort_order
      if (!Array.isArray(body.order)) return errorResponse('参数错误', 400);

      const ordered = body.order.map(normalizeDomain).filter(Boolean);

      // 批量 UPSERT，设置 sort_order
      for (let i = 0; i < ordered.length; i++) {
        const domain = ordered[i];
        if (!configDomains.includes(domain)) continue;
        await db.prepare(`
          INSERT INTO domains (domain, enabled, sort_order) VALUES (?, 1, ?)
          ON CONFLICT(domain) DO UPDATE SET sort_order = excluded.sort_order
        `).bind(domain, i).run();
      }

      return Response.json({ success: true });
    } catch (e) {
      return errorResponse('排序保存失败: ' + (e?.message || e), 500);
    }
  }

  return null;
}

/**
 * 检查某个域名是否允许使用（已启用）
 * 若数据库中没有记录，默认为已启用
 * @param {object} db
 * @param {string} domain
 * @returns {Promise<boolean>}
 */
export async function isDomainEnabled(db, domain) {
  try {
    const row = await db.prepare(
      'SELECT enabled FROM domains WHERE domain = ? LIMIT 1'
    ).bind(normalizeDomain(domain)).first();
    // 没有记录 → 默认启用
    if (!row) return true;
    return !!row.enabled;
  } catch (_) {
    return true;
  }
}
