module.exports = {
  apps: [{
    name: 'youtube-mp3',
    script: './server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'development',
      DOTENV_CONFIG_PATH: '.env'
    },
    env_production: {
      NODE_ENV: 'production',
      DOTENV_CONFIG_PATH: '.env.production'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    // Tự động restart khi crash
    min_uptime: '10s',
    max_restarts: 10,
    // Giới hạn restart
    restart_delay: 4000
  }]
};
