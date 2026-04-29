// Load environment variables từ file .env (hoặc file custom)
// Sử dụng: node server.js hoặc DOTENV_CONFIG_PATH=.env.production node server.js
const path = require('path');
const envPath = process.env.DOTENV_CONFIG_PATH || process.env.NODE_ENV || '.env';
const envFilePath = path.resolve(process.cwd(), envPath);

// Chỉ log nếu không phải .env mặc định (để tránh confusion)
if (envPath !== '.env') {
    console.log(`📝 Loading env from: ${envFilePath}`);
}

require('dotenv').config({ path: envFilePath });
const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');

const execAsync = promisify(exec);
const app = express();

// Cấu hình CORS từ .env hoặc cho phép tất cả
const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({
    origin: corsOrigin
}));
app.use(express.json());

// Cấu hình Python để chạy yt-dlp (lấy từ .env hoặc dùng mặc định)
const PYTHON_PATH = process.env.PYTHON_PATH || '/usr/bin/python3';
const YT_DLP_PATH = process.env.YT_DLP_PATH || path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');

// Phục vụ file tĩnh từ folder public
app.use(express.static('public'));

// Tạo folder tạm để chứa file nhạc (nếu chưa có)
const TEMP_DIR = path.join(__dirname, process.env.TEMP_DIR || 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

// Hàm làm sạch tên file (loại bỏ ký tự đặc biệt hệ điều hành)
function sanitizeFilename(name) {
    if (!name) return 'nhac';
    return name.replace(/[/\\?%*:|"<>]/g, '-').trim();
}

// Hàm làm sạch URL YouTube (chỉ giữ video ID, loại bỏ playlist)
function cleanYouTubeUrl(url) {
    if (!url) return url;

    // Extract video ID from various YouTube URL formats
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
        /[?&]v=([^&\n?#]+)/
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
            return `https://www.youtube.com/watch?v=${match[1]}`;
        }
    }

    return url;
}

// ---------------- API 1: LẤY THÔNG TIN BÀI HÁT ----------------
app.get('/api/info', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Thiếu URL' });

    const cleanUrl = cleanYouTubeUrl(url);
    console.log(`[INFO] Fetching info for: ${cleanUrl}`);

    try {
        const { stdout, stderr } = await execAsync(
            `"${PYTHON_PATH}" "${YT_DLP_PATH}" "${cleanUrl}" --dump-single-json --no-warnings --no-playlist`,
            { maxBuffer: 10 * 1024 * 1024 } // Tăng buffer lên 10MB
        );
        const info = JSON.parse(stdout);

        res.json({
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration_string,
            uploader: info.uploader
        });
    } catch (error) {
        // Log chi tiết lỗi để debug trên VPS
        console.error('===== ERROR DETAILS =====');
        console.error(`[ERROR] Message: ${error.message}`);
        console.error(`[ERROR] Code: ${error.code}`);
        console.error(`[ERROR] Killed: ${error.killed}`);
        console.error(`[ERROR] Stderr: ${error.stderr || 'No stderr'}`);
        console.error(`[ERROR] Stdout: ${error.stdout ? error.stdout.substring(0, 500) : 'No stdout'}`);
        console.error(`[ERROR] Python Path: ${PYTHON_PATH}`);
        console.error(`[ERROR] yt-dlp Path: ${YT_DLP_PATH}`);
        console.error(`[ERROR] Command: "${PYTHON_PATH}" "${YT_DLP_PATH}" "${cleanUrl}" --dump-single-json --no-warnings --no-playlist`);
        console.error('===== END ERROR DETAILS =====');

        res.status(500).json({ error: 'Link không hợp lệ hoặc đã bị giới hạn. Vui lòng thử link khác.' });
    }
});

// ---------------- API 2: TẢI NHẠC MP3 (TỐC ĐỘ CAO) ----------------
app.get('/api/download', async (req, res) => {
    const url = req.query.url;
    const title = req.query.title || 'nhac';
    const quality = req.query.quality || process.env.DEFAULT_AUDIO_QUALITY || '128';

    const cleanUrl = cleanYouTubeUrl(url);
    const safeTitle = sanitizeFilename(title);
    const outputPath = path.join(TEMP_DIR, `${safeTitle}.mp3`);

    // Audio quality: 5 = 128kbps (nhanh), 0 = 320kbps (chat luong cao)
    const audioQuality = quality === '320' ? '0' : '5';

    // Format: chi lay audio, khong video
    const format = 'bestaudio[abr<=128]'; // Gioi han bitrate de tai nhanh hon

    console.log(`[INFO] Downloading: ${cleanUrl} | Quality: ${quality}kbps`);

    try {
        // Gửi header trước để browser biết là file download
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}.mp3"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // Gọi yt-dlp để tải và xử lý (tối ưu tốc độ)
        await execAsync(
            `"${PYTHON_PATH}" "${YT_DLP_PATH}" "${cleanUrl}" -o "${outputPath}" -f "${format}" -x --audio-format mp3 --audio-quality ${audioQuality} --embed-thumbnail --add-metadata --no-playlist --progress`,
            { maxBuffer: 10 * 1024 * 1024 }
        );

        // Kiểm tra file đã được tạo thành công chưa
        if (!fs.existsSync(outputPath)) {
            console.error('[ERROR] File not created after download');
            return res.status(500).json({ error: 'Lỗi khi tạo file MP3.' });
        }

        console.log(`[INFO] File created successfully: ${outputPath}`);

        // Gửi file về cho người dùng tải
        res.download(outputPath, `${safeTitle}.mp3`, (err) => {
            // Xóa file tạm sau khi tải xong
            if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
                console.log(`[INFO] Temp file deleted: ${outputPath}`);
            }
        });

    } catch (error) {
        // Log chi tiết lỗi để debug trên VPS
        console.error('===== DOWNLOAD ERROR DETAILS =====');
        console.error(`[ERROR] Message: ${error.message}`);
        console.error(`[ERROR] Code: ${error.code}`);
        console.error(`[ERROR] Stderr: ${error.stderr || 'No stderr'}`);
        console.error(`[ERROR] Python Path: ${PYTHON_PATH}`);
        console.error(`[ERROR] yt-dlp Path: ${YT_DLP_PATH}`);
        console.error(`[ERROR] Output Path: ${outputPath}`);
        console.error(`[ERROR] Clean URL: ${cleanUrl}`);
        console.error('===== END ERROR DETAILS =====');

        if (!res.headersSent) {
            res.status(500).json({ error: 'Quá trình tải bị lỗi. Vui lòng thử lại.' });
        }
    }
});

// ---------------- API 3: TẢI NHẠC MP3 (CÓ PROGRESS) ----------------
app.get('/api/download-progress', async (req, res) => {
    const url = req.query.url;
    const title = req.query.title || 'nhac';
    const quality = req.query.quality || process.env.DEFAULT_AUDIO_QUALITY || '128';

    const cleanUrl = cleanYouTubeUrl(url);
    const safeTitle = sanitizeFilename(title);
    const outputPath = path.join(TEMP_DIR, `${safeTitle}.mp3`);
    const audioQuality = quality === '320' ? '0' : '5';
    const format = quality === '320' ? 'bestaudio' : 'bestaudio[abr<=128]';

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendProgress = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    console.log(`[INFO] Download with progress: ${cleanUrl} | Quality: ${quality}kbps`);

    try {
        sendProgress({ status: 'Đang chuẩn bị...', progress: 0, stage: 'preparing' });

        const args = [
            YT_DLP_PATH,
            cleanUrl,
            '-o', outputPath,
            '-f', format,
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', audioQuality,
            '--embed-thumbnail',
            '--add-metadata',
            '--no-playlist',
            '--newline',
            '--no-warnings'
        ];

        // Log command để debug
        console.log(`[DEBUG] Command: ${PYTHON_PATH} ${args.join(' ')}`);

        const ytDlp = spawn(PYTHON_PATH, args);

        let lastProgress = 0;
        let isConverting = false;
        let errorOutput = ''; // Thu thập lỗi từ stderr

        // Parse progress từ cả stdout và stderr
        ytDlp.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            parseProgress(lines);
        });

        ytDlp.stderr.on('data', (data) => {
            const text = data.toString();
            errorOutput += text; // Thu thập lỗi
            const lines = text.split('\n');
            parseProgress(lines);
        });

        function parseProgress(lines) {
            for (const line of lines) {
                // Download progress: [download]  45.2% of 10.00MiB at  1.00MiB/s
                const downloadMatch = line.match(/\[download\]\s+(\d+\.?\d*)%/);
                if (downloadMatch && !isConverting) {
                    const progress = parseFloat(downloadMatch[1]);
                    // Chỉ update khi progress thay đổi đáng kể (tránh spam)
                    if (progress - lastProgress >= 1 || progress === 100) {
                        lastProgress = progress;
                        sendProgress({
                            status: `Đang tải... ${Math.round(progress)}%`,
                            progress: Math.round(progress * 0.8), // Download chiếm 80%
                            stage: 'download',
                            downloadPercent: Math.round(progress)
                        });
                    }
                }

                // Detect khi bắt đầu convert
                if (line.includes('[ffmpeg]') || line.includes('Converting audio')) {
                    isConverting = true;
                    sendProgress({
                        status: 'Đang chuyển đổi sang MP3...',
                        progress: 80,
                        stage: 'converting'
                    });
                }

                // Destination file (khi convert xong)
                if (line.includes('[ffmpeg] Destination:')) {
                    sendProgress({
                        status: 'Đang hoàn thiện...',
                        progress: 95,
                        stage: 'finalizing'
                    });
                }
            }
        }

        ytDlp.on('close', async (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                console.log(`[INFO] Download completed: ${safeTitle}.mp3`);
                sendProgress({
                    status: 'Hoàn thành!',
                    progress: 100,
                    stage: 'complete',
                    downloadUrl: `/api/download-file?filename=${encodeURIComponent(safeTitle)}.mp3`
                });
            } else {
                // Log chi tiết lỗi để debug
                console.error('===== DOWNLOAD PROGRESS ERROR =====');
                console.error(`[ERROR] Exit code: ${code}`);
                console.error(`[ERROR] File exists: ${fs.existsSync(outputPath)}`);
                console.error(`[ERROR] Python: ${PYTHON_PATH}`);
                console.error(`[ERROR] yt-dlp: ${YT_DLP_PATH}`);
                console.error(`[ERROR] Stderr output:\n${errorOutput}`);
                console.error('===== END ERROR =====');

                // Gửi lỗi chi tiết về frontend
                const errorMsg = errorOutput.includes('ffmpeg') || errorOutput.includes('FFmpeg')
                    ? 'Lỗi: Chưa cài đặt FFmpeg trên server'
                    : errorOutput.includes('not found')
                    ? 'Lỗi: Python hoặc yt-dlp không tìm thấy'
                    : 'Không thể tải bài hát. Vui lòng thử lại.';

                sendProgress({
                    status: 'Lỗi!',
                    progress: 0,
                    stage: 'error',
                    error: errorMsg
                });
            }
            res.end();
        });

        ytDlp.on('error', (err) => {
            console.error('[ERROR] yt-dlp spawn error:', err);
            sendProgress({
                status: 'Lỗi!',
                progress: 0,
                stage: 'error',
                error: err.message
            });
            res.end();
        });

    } catch (error) {
        sendProgress({
            status: 'Lỗi!',
            progress: 0,
            stage: 'error',
            error: error.message
        });
        res.end();
    }
});

// ---------------- API 4: TẢI FILE SAU KHI XONG ----------------
app.get('/api/download-file', (req, res) => {
    const filename = req.query.filename;
    const safeFilename = sanitizeFilename(filename.replace('.mp3', ''));
    const filePath = path.join(TEMP_DIR, `${safeFilename}.mp3`);

    if (fs.existsSync(filePath)) {
        res.download(filePath, `${safeFilename}.mp3`, (err) => {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        });
    } else {
        res.status(404).json({ error: 'File không tồn tại.' });
    }
});

// ---------------- API 5: HEALTH CHECK (Kiểm tra dependencies) ----------------
app.get('/api/health', async (req, res) => {
    const checks = {
        python: { installed: false, version: null, path: PYTHON_PATH },
        ffmpeg: { installed: false, version: null },
        ytDlp: { installed: false, version: null, path: YT_DLP_PATH },
        tempDir: { exists: false, path: TEMP_DIR, writable: false }
    };

    // Kiểm tra Python
    try {
        const { stdout } = await execAsync(`"${PYTHON_PATH}" --version`);
        checks.python.installed = true;
        checks.python.version = stdout.trim();
    } catch (error) {
        checks.python.error = error.message;
    }

    // Kiểm tra FFmpeg
    try {
        const { stdout } = await execAsync('ffmpeg -version');
        checks.ffmpeg.installed = true;
        checks.ffmpeg.version = stdout.split('\n')[0];
    } catch (error) {
        checks.ffmpeg.error = 'FFmpeg không được cài đặt';
    }

    // Kiểm tra yt-dlp
    try {
        const { stdout } = await execAsync(`"${PYTHON_PATH}" "${YT_DLP_PATH}" --version`);
        checks.ytDlp.installed = true;
        checks.ytDlp.version = stdout.trim();
    } catch (error) {
        checks.ytDlp.error = error.message;
    }

    // Kiểm tra temp dir
    checks.tempDir.exists = fs.existsSync(TEMP_DIR);
    if (checks.tempDir.exists) {
        try {
            fs.accessSync(TEMP_DIR, fs.constants.W_OK);
            checks.tempDir.writable = true;
        } catch (error) {
            checks.tempDir.error = 'Temp dir không có quyền ghi';
        }
    }

    // Tính tổng trạng thái
    const allChecksPassed = checks.python.installed && checks.ffmpeg.installed && checks.ytDlp.installed && checks.tempDir.writable;

    res.json({
        status: allChecksPassed ? 'healthy' : 'unhealthy',
        checks,
        timestamp: new Date().toISOString()
    });
});

// Chạy server ở cổng từ .env hoặc mặc định 8080
const PORT = process.env.PORT || 8080;

// Hàm kiểm tra file/path có tồn tại không
function checkPathExists(label, filePath) {
    const exists = fs.existsSync(filePath);
    return `${exists ? '✅' : '❌'} ${label}: ${filePath} ${exists ? '' : '(KHÔNG TỒN TẠI!)'}`;
}

// Hàm kiểm tra biến môi trường
function checkEnvVar(label, value, defaultValue = 'CHƯA CẤU HÌNH') {
    const displayValue = value || defaultValue;
    return `${label}: ${displayValue}`;
}

app.listen(PORT, async () => {
    console.log('\n=================================');
    console.log('🚀 YouTube MP3 Downloader Starting...');
    console.log('=================================\n');

    // Environment Info
    console.log('📋 ENVIRONMENT:');
    console.log(`   ${checkEnvVar('NODE_ENV', process.env.NODE_ENV, 'development')}`);
    console.log(`   ${checkEnvVar('PORT', PORT)}`);
    console.log(`   ${checkEnvVar('BASE_URL', process.env.BASE_URL)}`);

    // Server Info
    console.log('\n🌐 SERVER:');
    console.log(`   Local URL: http://localhost:${PORT}`);
    console.log(`   External URL: ${process.env.BASE_URL || 'N/A'}`);

    // Python Configuration
    console.log('\n🐍 PYTHON CONFIG:');
    console.log(`   ${checkEnvVar('PYTHON_PATH', PYTHON_PATH)}`);
    try {
        const { stdout } = await execAsync(`"${PYTHON_PATH}" --version 2>&1`);
        console.log(`   ✅ Python Version: ${stdout.trim()}`);
    } catch (error) {
        console.log(`   ❌ Python Error: ${error.message.replace(/\n/g, ' ')}`);
    }

    // yt-dlp Configuration
    console.log('\n📼 YT-DLP CONFIG:');
    console.log(`   ${checkEnvVar('YT_DLP_PATH', YT_DLP_PATH)}`);
    const ytDlpAbsolutePath = path.resolve(process.cwd(), YT_DLP_PATH);
    console.log(`   ${checkPathExists('Absolute Path', ytDlpAbsolutePath)}`);
    try {
        const { stdout } = await execAsync(`"${PYTHON_PATH}" "${YT_DLP_PATH}" --version 2>&1`);
        console.log(`   ✅ yt-dlp Version: ${stdout.trim()}`);
    } catch (error) {
        console.log(`   ❌ yt-dlp Error: ${error.message.replace(/\n/g, ' ')}`);
    }

    // FFmpeg Check
    console.log('\n🎬 FFMPEG:');
    try {
        const { stdout } = await execAsync('ffmpeg -version 2>&1');
        console.log(`   ✅ FFmpeg: ${stdout.split('\n')[0]}`);
    } catch (error) {
        console.log(`   ❌ FFmpeg Error: CHƯA CÀI ĐẶT! (sudo apt install ffmpeg -y)`);
    }

    // Temp Directory
    console.log('\n📁 TEMP DIRECTORY:');
    console.log(`   ${checkEnvVar('TEMP_DIR', process.env.TEMP_DIR)}`);
    console.log(`   ${checkPathExists('Absolute Path', TEMP_DIR)}`);
    try {
        fs.accessSync(TEMP_DIR, fs.constants.W_OK);
        console.log(`   ✅ Writable: YES`);
    } catch (error) {
        console.log(`   ❌ Writable: NO (Không có quyền ghi!)`);
    }

    // Download Settings
    console.log('\n⚙️  DOWNLOAD SETTINGS:');
    console.log(`   ${checkEnvVar('DEFAULT_AUDIO_QUALITY', process.env.DEFAULT_AUDIO_QUALITY, '128kbps')}`);
    console.log(`   ${checkEnvVar('CORS_ORIGIN', process.env.CORS_ORIGIN, '*')}`);

    // Security
    console.log('\n🔒 SECURITY:');
    if (process.env.CORS_ORIGIN === '*') {
        console.log(`   ⚠️  CORS: Cho phép tất cả origins (*)`);
    } else {
        console.log(`   ✅ CORS: Chỉ cho phép ${process.env.CORS_ORIGIN}`);
    }

    console.log('\n=================================');
    console.log('✅ Server Ready! Listening for requests...');
    console.log('=================================\n');
});
