import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DATA_DIR = "./data";
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

const pathPrivate = path.join(DATA_DIR, "luma_private.sqlite");
const dbPrivate = new Database(pathPrivate);

const pathMetrics = path.join(DATA_DIR, "luma_metrics.sqlite");
const dbMetrics = new Database(pathMetrics);

dbPrivate.pragma("journal_mode = WAL");
dbMetrics.pragma("journal_mode = WAL");

// ==================== TABELAS EXISTENTES ====================

dbPrivate.exec(`
  CREATE TABLE IF NOT EXISTS chat_settings (
    jid TEXT PRIMARY KEY,
    personality TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

dbPrivate.exec(`
  CREATE TABLE IF NOT EXISTS wa_users (
    jid           TEXT PRIMARY KEY,
    lid           TEXT,
    phone_number  TEXT,
    push_name     TEXT,
    contact_name  TEXT,
    notify_name   TEXT,
    verified_name TEXT,
    bot_nickname  TEXT,
    first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

dbPrivate.exec(`
  CREATE TABLE IF NOT EXISTS luma_interactions (
    group_jid  TEXT NOT NULL,
    sender_jid TEXT NOT NULL,
    count      INTEGER DEFAULT 0,
    last_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_jid, sender_jid)
  );
  CREATE INDEX IF NOT EXISTS idx_interactions_group ON luma_interactions(group_jid, count DESC);
`);

dbPrivate.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid     TEXT NOT NULL,
    is_group     INTEGER NOT NULL DEFAULT 0,
    creator_jid  TEXT NOT NULL,
    mention_jids TEXT NOT NULL DEFAULT '[]',
    text         TEXT NOT NULL,
    fire_at      INTEGER NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    fired        INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(fired, fire_at);
`);

// ==================== NOVAS TABELAS PARA MÉTRICAS DE ÁUDIO ====================

// 🆕 Tabela para métricas por usuário
dbPrivate.exec(`
  CREATE TABLE IF NOT EXISTS user_metrics (
    user_id           TEXT PRIMARY KEY,
    audios_downloaded INTEGER DEFAULT 0,
    stickers_created  INTEGER DEFAULT 0,
    messages_sent     INTEGER DEFAULT 0,
    last_audio_download DATETIME,
    last_active       DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 🆕 Tabela para métricas temporárias (ex: limites diários)
dbPrivate.exec(`
  CREATE TABLE IF NOT EXISTS temp_metrics (
    key        TEXT PRIMARY KEY,
    value      INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ==================== TABELAS EXISTENTES DE MÉTRICAS ====================

dbMetrics.exec(`
  CREATE TABLE IF NOT EXISTS metrics (
    key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS stats_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    data TEXT NOT NULL
  );
`);

// ==================== CLASSE DatabaseService ====================

export class DatabaseService {

  // ========== MÉTODOS EXISTENTES ==========

  static getPersonality(jid) {
    const stmt = dbPrivate.prepare("SELECT personality FROM chat_settings WHERE jid = ?");
    const row = stmt.get(jid);
    return row ? row.personality : null;
  }

  static setPersonality(jid, personalityKey) {
    const stmt = dbPrivate.prepare(`
      INSERT INTO chat_settings (jid, personality, updated_at) 
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(jid) DO UPDATE SET 
        personality = excluded.personality,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(jid, personalityKey);
  }

  static incrementMetric(key) {
    const stmt = dbMetrics.prepare(`
      INSERT INTO metrics (key, count) 
      VALUES (?, 1)
      ON CONFLICT(key) DO UPDATE SET count = count + 1
    `);
    stmt.run(key);
  }

  static getMetrics() {
    const stmt = dbMetrics.prepare("SELECT key, count FROM metrics");
    const rows = stmt.all();

    const stats = {};
    rows.forEach(row => {
      stats[row.key] = row.count;
    });
    return stats;
  }

  static saveSnapshot(fullStats) {
    const stmt = dbMetrics.prepare("INSERT INTO stats_history (data) VALUES (?)");
    stmt.run(JSON.stringify(fullStats));
  }

  static getHistory(limit = 5) {
    const stmt = dbMetrics.prepare("SELECT timestamp, data FROM stats_history ORDER BY id DESC LIMIT ?");
    return stmt.all(limit).map(row => {
      let stats = null;
      try {
        stats = JSON.parse(row.data);
      } catch (e) {
        // Dado corrompido no banco — ignora silenciosamente
      }
      return { date: row.timestamp, stats };
    });
  }

  // ========== MÉTODOS DE USUÁRIO (EXISTENTES) ==========

  static upsertWaUser(jid, data = {}) {
    if (!jid) return;

    dbPrivate
      .prepare("INSERT INTO wa_users (jid) VALUES (?) ON CONFLICT(jid) DO NOTHING")
      .run(jid);

    const columns = {
      lid: data.lid,
      phone_number: data.phoneNumber,
      push_name: data.pushName,
      contact_name: data.contactName,
      notify_name: data.notifyName,
      verified_name: data.verifiedName,
      bot_nickname: data.botNickname,
    };

    const sets = [];
    const values = [];
    for (const [col, val] of Object.entries(columns)) {
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        sets.push(`${col} = ?`);
        values.push(val);
      }
    }

    sets.push("last_seen_at = CURRENT_TIMESTAMP");
    values.push(jid);
    dbPrivate.prepare(`UPDATE wa_users SET ${sets.join(", ")} WHERE jid = ?`).run(...values);
  }

  static getWaUser(jid) {
    if (!jid) return null;
    return dbPrivate.prepare("SELECT * FROM wa_users WHERE jid = ?").get(jid) || null;
  }

  static getAllWaUsers() {
    return dbPrivate.prepare("SELECT * FROM wa_users ORDER BY last_seen_at DESC").all();
  }

  static setNickname(jid, nickname) {
    if (!jid) return;
    dbPrivate.prepare(`
      INSERT INTO wa_users (jid, bot_nickname) VALUES (?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        bot_nickname = excluded.bot_nickname,
        last_seen_at = CURRENT_TIMESTAMP
    `).run(jid, nickname);
  }

  // ========== RANKING (EXISTENTE) ==========

  static incrementInteraction(groupJid, senderJid) {
    if (!groupJid || !senderJid) return;
    dbPrivate.prepare(`
      INSERT INTO luma_interactions (group_jid, sender_jid, count, last_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(group_jid, sender_jid) DO UPDATE SET
        count = count + 1,
        last_at = CURRENT_TIMESTAMP
    `).run(groupJid, senderJid);
  }

  static getGroupRanking(groupJid, limit = 10) {
    return dbPrivate.prepare(`
      SELECT sender_jid, count, last_at FROM luma_interactions
      WHERE group_jid = ?
      ORDER BY count DESC
      LIMIT ?
    `).all(groupJid, limit);
  }

  static getGlobalRanking(limit = 10) {
    return dbPrivate.prepare(`
      SELECT sender_jid, SUM(count) AS count, MAX(last_at) AS last_at
      FROM luma_interactions
      GROUP BY sender_jid
      ORDER BY count DESC
      LIMIT ?
    `).all(limit);
  }

  // ========== LEMBRETES (EXISTENTE) ==========

  static addReminder({ chatJid, isGroup, creatorJid, mentionJids, text, fireAt }) {
    const info = dbPrivate.prepare(`
      INSERT INTO reminders (chat_jid, is_group, creator_jid, mention_jids, text, fire_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(chatJid, isGroup ? 1 : 0, creatorJid, JSON.stringify(mentionJids ?? []), text, fireAt);
    return info.lastInsertRowid;
  }

  static getDueReminders(nowMs) {
    return dbPrivate
      .prepare("SELECT * FROM reminders WHERE fired = 0 AND fire_at <= ? ORDER BY fire_at ASC")
      .all(nowMs);
  }

  static getPendingReminders() {
    return dbPrivate
      .prepare("SELECT * FROM reminders WHERE fired = 0 ORDER BY fire_at ASC")
      .all();
  }

  static markReminderFired(id) {
    dbPrivate.prepare("UPDATE reminders SET fired = 1 WHERE id = ?").run(id);
  }

  static deleteReminder(id) {
    dbPrivate.prepare("DELETE FROM reminders WHERE id = ?").run(id);
  }

  // ========== 🆕 NOVOS MÉTODOS PARA MÉTRICAS DE ÁUDIO ==========

  /**
   * Atualiza métricas de um usuário específico
   * @param {string} userId - JID do usuário
   * @param {Object} data - Dados para atualizar
   */
  static updateUserMetric(userId, data = {}) {
    if (!userId) return;

    // Inserir ou criar usuário
    dbPrivate
      .prepare(`
        INSERT INTO user_metrics (user_id) 
        VALUES (?) 
        ON CONFLICT(user_id) DO NOTHING
      `)
      .run(userId);

    // Construir a query de update dinamicamente
    const updates = [];
    const values = [];

    if (data.audios_downloaded !== undefined) {
      updates.push("audios_downloaded = audios_downloaded + ?");
      values.push(data.audios_downloaded);
    }
    
    if (data.stickers_created !== undefined) {
      updates.push("stickers_created = stickers_created + ?");
      values.push(data.stickers_created);
    }
    
    if (data.messages_sent !== undefined) {
      updates.push("messages_sent = messages_sent + ?");
      values.push(data.messages_sent);
    }

    if (data.last_audio_download !== undefined) {
      updates.push("last_audio_download = ?");
      values.push(data.last_audio_download);
    }

    updates.push("last_active = CURRENT_TIMESTAMP");
    values.push(userId);

    if (updates.length > 1) {
      const stmt = dbPrivate.prepare(`
        UPDATE user_metrics 
        SET ${updates.join(", ")} 
        WHERE user_id = ?
      `);
      stmt.run(...values);
    }
  }

  /**
   * Busca métricas de um usuário específico
   * @param {string} userId - JID do usuário
   * @returns {Object|null} Métricas do usuário
   */
  static getUserMetrics(userId) {
    if (!userId) return null;
    return dbPrivate
      .prepare("SELECT * FROM user_metrics WHERE user_id = ?")
      .get(userId) || null;
  }

  /**
   * Atualiza uma métrica específica (incrementa)
   * @param {string} key - Nome da métrica
   * @param {number} value - Valor a incrementar (padrão: 1)
   */
  static updateMetric(key, value = 1) {
    const stmt = dbMetrics.prepare(`
      INSERT INTO metrics (key, count) 
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET count = count + ?
    `);
    stmt.run(key, value, value);
  }

  /**
   * Busca uma métrica específica
   * @param {string} key - Nome da métrica
   * @returns {number} Valor da métrica
   */
  static getMetric(key) {
    const stmt = dbMetrics.prepare("SELECT count FROM metrics WHERE key = ?");
    const row = stmt.get(key);
    return row ? row.count : 0;
  }

  /**
   * Busca uma métrica temporária (para limites diários, etc)
   * @param {string} key - Chave da métrica
   * @returns {number} Valor da métrica
   */
  static getTempMetric(key) {
    const stmt = dbPrivate.prepare("SELECT value FROM temp_metrics WHERE key = ?");
    const row = stmt.get(key);
    return row ? row.value : 0;
  }

  /**
   * Define uma métrica temporária
   * @param {string} key - Chave da métrica
   * @param {number} value - Valor a definir
   */
  static setTempMetric(key, value) {
    const stmt = dbPrivate.prepare(`
      INSERT INTO temp_metrics (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(key, value);
  }

  /**
   * Incrementa uma métrica temporária
   * @param {string} key - Chave da métrica
   * @param {number} increment - Valor a incrementar (padrão: 1)
   * @returns {number} Novo valor
   */
  static incrementTempMetric(key, increment = 1) {
    const current = this.getTempMetric(key);
    const newValue = current + increment;
    this.setTempMetric(key, newValue);
    return newValue;
  }

  /**
   * Limpa métricas temporárias antigas (ex: diárias)
   * @param {number} olderThanHours - Horas para considerar antigo
   */
  static cleanOldTempMetrics(olderThanHours = 24) {
    const stmt = dbPrivate.prepare(`
      DELETE FROM temp_metrics 
      WHERE datetime(updated_at) < datetime('now', ?)
    `);
    stmt.run(`-${olderThanHours} hours`);
  }

  /**
   * Busca estatísticas completas de um usuário para exibição
   * @param {string} userId - JID do usuário
   * @returns {Object} Estatísticas combinadas
   */
  static getUserStats(userId) {
    if (!userId) return null;

    const userMetrics = this.getUserMetrics(userId);
    const waUser = this.getWaUser(userId);
    const interactions = dbPrivate
      .prepare("SELECT SUM(count) as total_interactions FROM luma_interactions WHERE sender_jid = ?")
      .get(userId);

    return {
      user: waUser,
      metrics: userMetrics || {
        audios_downloaded: 0,
        stickers_created: 0,
        messages_sent: 0
      },
      interactions: interactions?.total_interactions || 0,
      total_audios: userMetrics?.audios_downloaded || 0,
      total_stickers: userMetrics?.stickers_created || 0,
      total_messages: userMetrics?.messages_sent || 0,
      last_active: userMetrics?.last_active || null
    };
  }

  // ========== MÉTRICAS DE ÁUDIO ESPECÍFICAS ==========

  /**
   * Incrementa o contador de áudios baixados para um usuário
   * @param {string} userId - JID do usuário
   */
  static incrementAudioDownload(userId) {
    // Métrica global
    this.incrementMetric("audios_downloaded");
    this.incrementMetric("total_messages");
    
    // Métrica por usuário
    this.updateUserMetric(userId, {
      audios_downloaded: 1,
      last_audio_download: new Date().toISOString()
    });
  }

  /**
   * Incrementa o contador de stickers criados para um usuário
   * @param {string} userId - JID do usuário
   */
  static incrementStickerCreated(userId) {
    this.incrementMetric("stickers_created");
    this.updateUserMetric(userId, {
      stickers_created: 1
    });
  }

  /**
   * Incrementa o contador de mensagens para um usuário
   * @param {string} userId - JID do usuário
   */
  static incrementMessageSent(userId) {
    this.incrementMetric("messages_sent");
    this.updateUserMetric(userId, {
      messages_sent: 1
    });
  }

  /**
   * Busca estatísticas de áudio para dashboard
   * @returns {Object} Estatísticas agregadas
   */
  static getAudioStats() {
    return {
      total_audios: this.getMetric("audios_downloaded"),
      total_messages: this.getMetric("total_messages"),
      // Top usuários por downloads
      top_users: dbPrivate
        .prepare(`
          SELECT user_id, audios_downloaded 
          FROM user_metrics 
          WHERE audios_downloaded > 0 
          ORDER BY audios_downloaded DESC 
          LIMIT 10
        `)
        .all(),
      // Últimos downloads
      recent_downloads: dbPrivate
        .prepare(`
          SELECT user_id, last_audio_download 
          FROM user_metrics 
          WHERE last_audio_download IS NOT NULL 
          ORDER BY last_audio_download DESC 
          LIMIT 20
        `)
        .all()
    };
  }
}
