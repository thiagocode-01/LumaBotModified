// src/plugins/download/AudioDownloadPlugin.js
import { COMMANDS, MESSAGES } from "../../config/constants.js";
import { VideoDownloader } from "../../services/VideoDownloader.js";
import { DatabaseService } from "../../services/Database.js";
import { extractUrl } from "../../utils/MessageUtils.js";
import { Logger } from "../../utils/Logger.js";
import fs from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";

export class AudioDownloadPlugin {
  // Aliases mais intuitivos
  static commands = [
    '!musica',     // 🇧🇷 Principal - mais natural em PT-BR
    '!music',      // 🇺🇸 Principal - internacional
    '!song',       // 🎵 Música
    '!track',      // 🎵 Faixa (seu pedido)
    '!audio',      // 🎙️ Genérico (mantendo compatibilidade)
    '!baixar'      // 📥 Download
  ];

  // Aliases para comandos específicos
  static aliasMap = {
    '!musica': 'audio',
    '!music': 'audio',
    '!song': 'audio',
    '!track': 'audio',
    '!audio': 'audio',
    '!baixar': 'audio'
  };

  // Emojis por tipo de comando
  static emojiMap = {
    '!musica': '🎵',
    '!music': '🎵',
    '!song': '🎶',
    '!track': '🎧',
    '!audio': '🎙️',
    '!baixar': '📥'
  };

  static config = {
    maxFileSize: 16 * 1024 * 1024,
    allowedFormats: ['mp3', 'm4a', 'aac', 'opus'],
    defaultFormat: 'mp3',
    maxTitleLength: 100,
    tempDir: '/tmp/luma_audio/'
  };

  async onCommand(command, bot) {
    try {
      const url = this.#extractUrlFromContext(bot);
      
      if (!url) {
        await this.#sendHelpMessage(bot);
        return;
      }

      if (!this.#isValidUrl(url)) {
        await bot.reply('🔗 URL inválida. Envie um link de vídeo (YouTube, Vimeo, etc.)');
        return;
      }

      const emoji = AudioDownloadPlugin.emojiMap[command] || '🎵';
      await bot.react("⏳");
      await bot.reply(`${emoji} Baixando áudio... Aguarde alguns segundos.`);

      await this.#downloadAndSendAudio(bot, url);
      
    } catch (error) {
      Logger.error('❌ Erro no AudioDownloadPlugin:', error);
      await this.#handleError(bot, error);
    }
  }

  async #sendHelpMessage(bot) {
    const helpMessage = `
🎵 **Comandos de Áudio/Música:**

\`!musica\` ou \`!music\` - Baixa música (mais usado)
\`!song\` - Baixa música (em inglês)
\`!track\` - Baixa faixa de áudio
\`!audio\` - Baixa áudio (compatibilidade)
\`!baixar\` - Baixa áudio (em português)

📌 **Uso:** \`!musica [link do YouTube/Vídeo]\`
💡 **Dica:** Use respondendo a uma mensagem com link

**Exemplos:**
\`!musica https://youtube.com/watch?v=abc123\`
\`!song https://youtu.be/abc123\`
\`!track https://soundcloud.com/track\`

🎯 **Aliases suportados:** música, music, song, track, audio, baixar
    `;
    
    await bot.reply(helpMessage);
  }

  #extractUrlFromContext(bot) {
    const sources = [
      bot.body,
      bot.quotedText,
      bot.message?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation,
      bot.message?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text
    ];

    for (const source of sources) {
      if (source) {
        const url = extractUrl(source);
        if (url) return url;
      }
    }
    return null;
  }

  #isValidUrl(url) {
    try {
      const parsed = new URL(url);
      return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  async #downloadAndSendAudio(bot, url) {
    let filePath = null;
    let tempDir = null;

    try {
      // Extrair informações do vídeo primeiro
      const videoInfo = await VideoDownloader.getVideoInfo(url);
      
      if (videoInfo) {
        const durationMinutes = Math.floor(videoInfo.duration / 60);
        if (durationMinutes > 30) {
          await bot.reply('⏱️ Vídeo muito longo (>30min). Tente um mais curto.');
          return;
        }
      }

      tempDir = AudioDownloadPlugin.config.tempDir;
      await fs.mkdir(tempDir, { recursive: true });

      const result = await VideoDownloader.downloadAudio(url, {
        format: AudioDownloadPlugin.config.defaultFormat,
        quality: 'best',
        outputDir: tempDir
      });

      if (!result?.filePath) {
        throw new Error('Falha ao baixar áudio');
      }

      filePath = result.filePath;
      const stats = await fs.stat(filePath);
      
      if (stats.size > AudioDownloadPlugin.config.maxFileSize) {
        throw new Error(`Arquivo muito grande: ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
      }

      const fileName = this.#sanitizeFileName(result.title || 'audio', filePath);
      const audioBuffer = await fs.readFile(filePath);
      
      // Título com emoji baseado no comando
      const command = bot.body.match(/!(\w+)/)?.[1] || 'audio';
      const emoji = this.#getCommandEmoji(command);
      
      const caption = this.#buildCaption(result.title, result.duration, stats.size, emoji);
      
      await bot.sendMessage(bot.jid, {
        audio: audioBuffer,
        mimetype: "audio/mpeg",
        fileName: fileName,
        caption: caption,
        ptt: false
      });

      await this.#updateMetrics(bot, stats.size, result.duration);
      
      Logger.info(`✅ Áudio enviado: ${fileName}`);
      await bot.react("✅");

    } catch (error) {
      Logger.error('❌ Erro no download:', error);
      throw error;
    } finally {
      await this.#cleanupFiles(filePath, tempDir);
    }
  }

  #getCommandEmoji(command) {
    const emojiMap = {
      'musica': '🎵',
      'music': '🎵',
      'song': '🎶',
      'track': '🎧',
      'audio': '🎙️',
      'baixar': '📥'
    };
    return emojiMap[command] || '🎵';
  }

  #sanitizeFileName(title, filePath) {
    if (!title) {
      return path.basename(filePath);
    }
    
    const sanitized = title
      .replace(/[/\\?%*:|"<>]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, AudioDownloadPlugin.config.maxTitleLength);
      
    return `${sanitized}.${AudioDownloadPlugin.config.defaultFormat}`;
  }

  #buildCaption(title, duration, fileSize, emoji = '🎵') {
    let caption = `${emoji} **Áudio baixado!**\n\n`;
    
    if (title) {
      caption += `📝 **${title}**\n`;
    }
    
    if (duration) {
      const minutes = Math.floor(duration / 60);
      const seconds = Math.floor(duration % 60);
      caption += `⏱️ ${minutes}m${seconds.toString().padStart(2, '0')}s\n`;
    }
    
    if (fileSize) {
      const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
      caption += `📦 ${sizeMB}MB\n`;
    }
    
    caption += `\n💡 Aliases: !musica, !song, !track, !audio, !baixar`;
    
    return caption;
  }

  async #updateMetrics(bot, fileSize, duration) {
    try {
      await DatabaseService.incrementMetric("audios_downloaded");
      await DatabaseService.incrementMetric("total_messages");
      await DatabaseService.updateMetric("total_audio_size", fileSize);
      await DatabaseService.updateMetric("total_audio_duration", duration || 0);
      
      await DatabaseService.updateUserMetric(bot.sender, {
        audios_downloaded: 1,
        last_audio_download: new Date().toISOString()
      });
      
    } catch (error) {
      Logger.warn('⚠️ Erro ao atualizar métricas:', error);
    }
  }

  async #handleError(bot, error) {
    const errorMessages = {
      'yt-dlp': '⚠️ yt-dlp não encontrado.\n\n📌 Instale com:\n`npm install -g yt-dlp`\n\n🔄 Ou use:\n`pip install yt-dlp`',
      'File too large': '📦 Áudio muito grande (máx 16MB).\n💡 Tente um vídeo mais curto.',
      'Network': '🌐 Erro de rede.\n🔄 Verifique sua conexão e tente novamente.',
      'Unsupported': '📹 Formato não suportado.\n💡 Tente outro vídeo.',
      'duration': '⏱️ Vídeo muito longo.\n💡 Use vídeos com menos de 30 minutos.',
      '404': '❌ Vídeo não encontrado.\n💡 Verifique se o link está correto.'
    };

    let userMessage = '❌ Erro ao baixar áudio. Tente novamente.\n\n💡 Use `!musica` + link do YouTube.';
    
    for (const [key, msg] of Object.entries(errorMessages)) {
      if (error.message?.toLowerCase().includes(key.toLowerCase())) {
        userMessage = msg;
        break;
      }
    }

    await bot.reply(userMessage);
    await bot.react("❌");
  }

  async #cleanupFiles(filePath, tempDir) {
    try {
      if (filePath) {
        await fs.unlink(filePath).catch(() => {});
      }
      if (tempDir) {
        const files = await fs.readdir(tempDir).catch(() => []);
        if (files.length === 0) {
          await fs.rmdir(tempDir).catch(() => {});
        }
      }
    } catch (error) {
      Logger.warn('⚠️ Erro na limpeza:', error);
    }
  }
}
