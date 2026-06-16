import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { CONFIG } from "../config/constants.js";
import { Logger } from "../utils/Logger.js";

const execFileAsync = promisify(execFile);

// Caminho do binário standalone do yt-dlp dentro do projeto
const isWindows = process.platform === "win32";
const YTDLP_BIN = path.join("bin", isWindows ? "yt-dlp.exe" : "yt-dlp");
const YTDLP_URL = isWindows
  ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
  : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

/**
 * Serviço de download de vídeos e áudios de redes sociais via yt-dlp.
 * Suporta Twitter/X, Instagram, YouTube, SoundCloud, Vimeo e mais.
 * Baixa automaticamente o binário standalone se não encontrar.
 */
export class VideoDownloader {
  // ✅ SUPORTE A MÚLTIPLAS PLATAFORMAS (MELHORADO)
  static SUPPORTED_PATTERNS = [
    // Twitter/X
    /https?:\/\/(www\.)?(twitter\.com|x\.com)\/\S+/i,
    // Instagram
    /https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv|stories)\/[^\s]+/i,
    // YouTube
    /https?:\/\/(www\.)?youtube\.com\/watch\?v=[^\s&]+/i,
    /https?:\/\/(www\.)?youtu\.be\/[^\s&]+/i,
    // SoundCloud
    /https?:\/\/(www\.)?soundcloud\.com\/[^\s]+/i,
    // Vimeo
    /https?:\/\/(www\.)?vimeo\.com\/[^\s]+/i,
    // TikTok
    /https?:\/\/(www\.)?tiktok\.com\/@[^\s]+\/video\/[^\s]+/i,
    // Facebook
    /https?:\/\/(www\.)?facebook\.com\/[^\s]+\/videos\/[^\s]+/i,
    /https?:\/\/(www\.)?fb\.watch\/[^\s]+/i,
  ];

  // Limite de tamanho do WhatsApp (16MB)
  static MAX_WHATSAPP_SIZE = 16 * 1024 * 1024; // 16MB em bytes

  /**
   * Detecta se o texto contém uma URL suportada.
   * Retorna a URL limpa ou null se não encontrar.
   */
  static detectVideoUrl(text) {
    if (!text) return null;
    for (const pattern of this.SUPPORTED_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        return match[0].replace(/[.,!?'"]+$/, "");
      }
    }
    return null;
  }

  /**
   * Retorna o caminho do binário yt-dlp local.
   * Se não existir no projeto, baixa automaticamente.
   */
  static async getBinaryPath() {
    if (!fs.existsSync(YTDLP_BIN)) {
      Logger.info("📦 yt-dlp não encontrado. Baixando binário standalone...");
      await this._downloadBinary();
    }
    return YTDLP_BIN;
  }

  /**
   * Baixa o binário standalone do yt-dlp do GitHub Releases.
   */
  static async _downloadBinary() {
    const binDir = path.dirname(YTDLP_BIN);
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

    const tmpPath = `${YTDLP_BIN}.tmp`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(YTDLP_URL, { 
        redirect: "follow", 
        signal: controller.signal 
      });
      clearTimeout(timeout);
      
      if (!response.ok) {
        throw new Error(
          `Falha ao baixar yt-dlp: ${response.status} ${response.statusText}`
        );
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength) > 50 * 1024 * 1024) {
        throw new Error("Binário yt-dlp muito grande (>50MB). Possível redirecionamento malicioso.");
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 1024) {
        throw new Error("Binário yt-dlp baixado parece estar corrompido (muito pequeno).");
      }

      fs.writeFileSync(tmpPath, buffer);
      fs.renameSync(tmpPath, YTDLP_BIN);
      if (!isWindows) fs.chmodSync(YTDLP_BIN, 0o755);

      Logger.info(`✅ yt-dlp baixado com sucesso → ${YTDLP_BIN}`);
    } catch (error) {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
      }
      throw error;
    }
  }

  /**
   * Valida se a URL é válida e tem protocolo suportado.
   */
  static #assertValidUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Protocolo não suportado');
      }
    } catch {
      throw new Error('URL inválida');
    }
  }

  /**
   * Obtém informações do vídeo sem baixá-lo.
   * @param {string} url - URL do vídeo
   * @returns {Promise<Object>} Informações do vídeo
   */
  static async getVideoInfo(url) {
    this.#assertValidUrl(url);
    const ytdlp = await this.getBinaryPath();

    try {
      const { stdout } = await execFileAsync(
        ytdlp,
        [
          "--skip-download",
          "--print", "%(title)s|%(duration)s|%(uploader)s|%(view_count)s|%(like_count)s",
          "--no-warnings",
          url
        ],
        { timeout: 15000 }
      );

      const [title, duration, uploader, views, likes] = stdout.trim().split('|');
      
      return {
        title: title || null,
        duration: parseFloat(duration) || 0,
        uploader: uploader || null,
        views: parseInt(views) || 0,
        likes: parseInt(likes) || 0,
        url: url
      };
    } catch (error) {
      Logger.warn(`⚠️ Erro ao obter info do vídeo: ${error.message}`);
      return null;
    }
  }

  /**
   * Baixa o vídeo da URL usando yt-dlp e retorna o caminho do arquivo.
   * @param {string} url - URL do vídeo
   * @param {Object} options - Opções de download
   * @returns {Promise<{ filePath: string, info: Object }>}
   */
  static async downloadVideo(url, options = {}) {
    this.#assertValidUrl(url);
    const ytdlp = await this.getBinaryPath();
    const id = crypto.randomUUID();
    const outputTemplate = path.join(
      CONFIG.TEMP_DIR,
      `ytdlp_${id}.%(ext)s`
    );

    // Pegar informações primeiro
    const info = await this.getVideoInfo(url);

    const args = [
      "-o", outputTemplate,
      "--format", options.format || CONFIG.VIDEO_DOWNLOAD_FORMAT || "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "--max-filesize", `${options.maxSize || CONFIG.VIDEO_DOWNLOAD_MAX_SIZE_MB || 100}M`,
      "--no-playlist",
      "--no-warnings",
      ...(options.quality ? [`"--quality", options.quality`] : []),
      url,
    ];

    Logger.info(`📥 VideoDownloader: Iniciando download de ${url}`);

    try {
      await execFileAsync(ytdlp, args, { 
        timeout: options.timeout || CONFIG.VIDEO_DOWNLOAD_TIMEOUT_MS || 240000 
      });
    } catch (error) {
      Logger.warn(`⚠️ VideoDownloader: yt-dlp saiu com erro: ${error.message}`);
    }

    // Localiza o arquivo gerado com o id único
    const tempFiles = fs
      .readdirSync(CONFIG.TEMP_DIR)
      .filter((f) => f.startsWith(`ytdlp_${id}.`))
      .map((f) => path.join(CONFIG.TEMP_DIR, f));

    if (tempFiles.length === 0) {
      throw new Error(
        "Arquivo não encontrado após download. Verifique se o conteúdo é público e a URL é válida."
      );
    }

    const filePath = tempFiles[0];
    const stats = fs.statSync(filePath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
    
    Logger.info(
      `✅ VideoDownloader: Download concluído (${sizeMB} MB) → ${path.basename(filePath)}`
    );

    return { 
      filePath, 
      info,
      size: stats.size,
      sizeMB: parseFloat(sizeMB)
    };
  }

  /**
   * Baixa somente o áudio da URL usando yt-dlp, converte para MP3 e embute
   * thumbnail (cover art) e metadados nas tags ID3.
   * 
   * @param {string} url - URL do vídeo
   * @param {Object} options - Opções de download
   * @returns {Promise<{ filePath: string, title: string|null, duration: number, size: number }>}
   */
  static async downloadAudio(url, options = {}) {
    this.#assertValidUrl(url);
    const ytdlp = await this.getBinaryPath();
    const id = crypto.randomUUID();
    const outputTemplate = path.join(
      CONFIG.TEMP_DIR,
      `ytdlp_audio_${id}.%(ext)s`
    );

    const format = options.format || 'mp3';
    const quality = options.quality || '0';

    const args = [
      "-x",
      "--audio-format", format,
      "--audio-quality", quality,
      "--embed-thumbnail",
      "--embed-metadata",
      "--convert-thumbnails", "jpg",
      "-o", outputTemplate,
      "--no-playlist",
      "--no-warnings",
      ...(options.maxSize ? [`"--max-filesize", `${options.maxSize}M`] : []),
      url,
    ];

    Logger.info(`📥 VideoDownloader (áudio): Iniciando download de ${url}`);

    // Buscar informações em paralelo com o download
    const [title, duration] = await Promise.all([
      this._fetchTitle(url, ytdlp),
      this._fetchDuration(url, ytdlp),
      execFileAsync(ytdlp, args, { 
        timeout: options.timeout || CONFIG.VIDEO_DOWNLOAD_TIMEOUT_MS || 240000 
      }).catch((err) => {
        Logger.warn(`⚠️ VideoDownloader (áudio): yt-dlp saiu com erro: ${err.message}`);
      }),
    ]);

    // Localizar arquivo gerado
    const tempFiles = fs
      .readdirSync(CONFIG.TEMP_DIR)
      .filter((f) => f.startsWith(`ytdlp_audio_${id}.`))
      .map((f) => path.join(CONFIG.TEMP_DIR, f));

    if (tempFiles.length === 0) {
      throw new Error(
        "Arquivo de áudio não encontrado após download. Verifique se o conteúdo é público e a URL é válida."
      );
    }

    const filePath = tempFiles[0];
    const stats = fs.statSync(filePath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(1);

    // Verificar tamanho do arquivo
    if (stats.size > this.MAX_WHATSAPP_SIZE) {
      // Limpar arquivo antes de lançar erro
      try { fs.unlinkSync(filePath); } catch (_) {}
      throw new Error(
        `Arquivo muito grande para o WhatsApp (${sizeMB}MB > 16MB). ` +
        `Tente um vídeo mais curto ou com menor qualidade.`
      );
    }

    Logger.info(
      `✅ VideoDownloader (áudio): Download concluído (${sizeMB} MB) → ${path.basename(filePath)}`
    );

    return {
      filePath,
      title: title || null,
      duration: duration || 0,
      size: stats.size,
      sizeMB: parseFloat(sizeMB),
      format: format
    };
  }

  /**
   * Busca o título do vídeo sem baixá-lo. Falha silenciosa — retorna null.
   */
  static async _fetchTitle(url, ytdlp) {
    try {
      const { stdout } = await execFileAsync(
        ytdlp,
        ["--skip-download", "--print", "%(title)s", "--no-warnings", url],
        { timeout: 15000 }
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Busca a duração do vídeo sem baixá-lo. Falha silenciosa — retorna 0.
   */
  static async _fetchDuration(url, ytdlp) {
    try {
      const { stdout } = await execFileAsync(
        ytdlp,
        ["--skip-download", "--print", "%(duration)s", "--no-warnings", url],
        { timeout: 15000 }
      );
      return parseFloat(stdout.trim()) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Verifica se uma URL é suportada.
   * @param {string} url - URL a ser verificada
   * @returns {boolean} True se for suportada
   */
  static isSupportedUrl(url) {
    if (!url) return false;
    return this.SUPPORTED_PATTERNS.some(pattern => pattern.test(url));
  }

  /**
   * Limpa arquivos temporários antigos.
   * @param {number} olderThanMinutes - Idade em minutos para considerar antigo
   */
  static cleanTempFiles(olderThanMinutes = 60) {
    try {
      const files = fs.readdirSync(CONFIG.TEMP_DIR);
      const now = Date.now();
      let cleaned = 0;

      for (const file of files) {
        if (!file.startsWith('ytdlp_')) continue;
        
        const filePath = path.join(CONFIG.TEMP_DIR, file);
        const stats = fs.statSync(filePath);
        const ageMinutes = (now - stats.mtimeMs) / 1000 / 60;

        if (ageMinutes > olderThanMinutes) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        Logger.info(`🧹 Limpeza: ${cleaned} arquivos temporários removidos`);
      }
    } catch (error) {
      Logger.warn(`⚠️ Erro ao limpar arquivos temporários: ${error.message}`);
    }
  }
}

// Exportar constantes para uso em outros módulos
export const VideoDownloaderConfig = {
  MAX_WHATSAPP_SIZE: VideoDownloader.MAX_WHATSAPP_SIZE,
  SUPPORTED_PATTERNS: VideoDownloader.SUPPORTED_PATTERNS,
  YTDLP_BIN: YTDLP_BIN
};
