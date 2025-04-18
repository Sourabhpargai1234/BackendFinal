const express = require('express');
const axios = require('axios');
const { parseString } = require('xml2js');
const https = require('https');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

const app = express();

const isProduction = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.disable('x-powered-by');

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// CORS configuration
const corsOptions = {
  origin: isProduction ? process.env.ALLOWED_ORIGINS?.split(',') || '*' : '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Body parsers
app.use(express.json());
app.use(express.text({ type: ['text/xml', 'application/xml'] }));

// HTTPS agent
const httpsAgent = new https.Agent({
  rejectUnauthorized: isProduction,
  keepAlive: true,
  maxSockets: 100,
  timeout: 10000
});

// XML parser
const parseXml = (xml) => new Promise((resolve, reject) => {
  parseString(xml, {
    explicitArray: false,
    ignoreAttrs: true,
    trim: true,
    emptyTag: null
  }, (err, result) => err ? reject(err) : resolve(result));
});

// Input validation middleware
const validateInput = [
  // Content type validation
  (req, res, next) => {
    const contentType = req.get('Content-Type');
    if (!contentType) {
      return res.status(400).json({ error: "Content-Type header is required" });
    }
    if (!['application/json', 'application/xml', 'text/xml'].some(type => contentType.includes(type))) {
      return res.status(415).json({ error: "Unsupported Content-Type" });
    }
    next();
  },

  // Body parsing
  async (req, res, next) => {
    try {
      if (req.is('json')) {
        req.parsedBody = req.body;
      } else if (req.is(['xml', 'text/xml'])) {
        req.parsedBody = await parseXml(req.body);
      }
      next();
    } catch (e) {
      return res.status(400).json({ error: "Invalid input format", details: e.message });
    }
  },

  // API parameter validation
  body('api.url').isURL().withMessage('Invalid URL format'),
  body('api.method').isIn(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    .withMessage('Invalid HTTP method'),
  body('api.header').optional().isObject().withMessage('Headers must be an object'),
  body('api.body').optional(),

  // Validation result handling
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  }
];

// Helper functions
const tryParseJson = (str) => {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
};

const processHeaders = (rawHeaders = {}) => {
  const headers = { ...rawHeaders };
  
  // Set default headers if not provided
  if (!headers['Accept']) headers['Accept'] = 'application/json';
  if (!headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  return headers;
};

// API proxy endpoint
app.post('/', validateInput, async (req, res) => {
  try {
    const { api } = req.parsedBody;
    const { 
      url, 
      method = 'GET', 
      header = {}, 
      body: postData = {} 
    } = api;

    const processedHeaders = processHeaders(header);
    const requestMethod = method.toUpperCase();

    const config = {
      method: requestMethod,
      url,
      headers: processedHeaders,
      httpsAgent,
      timeout: 10000
    };

    // Add data for non-GET/HEAD requests
    if (requestMethod !== 'GET' && requestMethod !== 'HEAD') {
      if (postData && Object.keys(postData).length > 0) {
        config.data = typeof postData === 'string' ? tryParseJson(postData) : postData;
      }
    }

    const response = await axios(config);

    // Forward response
    res.set(response.headers)
      .status(response.status)
      .send(response.data);

  } catch (error) {
    console.error('Proxy error:', {
      message: error.message,
      code: error.code,
      stack: error.stack,
      response: error.response?.data
    });

    if (error.response) {
      // Forward error response from target API
      res.status(error.response.status)
        .set(error.response.headers)
        .send(error.response.data);
    } else if (error.code === 'ECONNABORTED') {
      res.status(504).json({ error: "Request timeout" });
    } else if (error.code === 'ENOTFOUND') {
      res.status(502).json({ error: "Failed to resolve host" });
    } else {
      res.status(500).json({
        error: "Internal proxy error",
        details: !isProduction ? error.message : undefined
      });
    }
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Not found handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: "Internal server error",
    details: !isProduction ? err.stack : undefined
  });
});

// Server startup
const server = app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});