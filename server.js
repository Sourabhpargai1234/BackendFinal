const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { parseString } = require('xml2js');
const https = require('https');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

const app = express();

// Environment configuration
const isProduction = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later'
});

// CORS configuration
const corsOptions = {
  origin: isProduction ? process.env.ALLOWED_ORIGINS?.split(',') || '*' : '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Body parser configuration
app.use(bodyParser.text({
  type: ['application/json', 'application/xml', 'text/xml'],
  limit: '10mb' // Prevent large payload attacks
}));

// Reusable HTTPS agent
const httpsAgent = new https.Agent({
  rejectUnauthorized: isProduction, // Only validate certs in production
  keepAlive: true,
  maxSockets: 100,
  timeout: 10000
});

// XML parser helper
const parseXml = (xml) => new Promise((resolve, reject) => {
  parseString(xml, { 
    explicitArray: false, 
    ignoreAttrs: true,
    trim: true,
    emptyTag: null // Handle empty tags consistently
  }, (err, result) => err ? reject(err) : resolve(result));
});

// Input validation middleware
const validateInput = [
  // Validate Content-Type header
  (req, res, next) => {
    const contentType = req.headers['content-type'] || '';
    if (!['application/json', 'application/xml', 'text/xml'].some(type => contentType.includes(type))) {
      return res.status(415).json({ error: "Unsupported Content-Type" });
    }
    next();
  },
  
  // Validate request body based on content type
  async (req, res, next) => {
    try {
      const contentType = req.headers['content-type'] || '';
      
      if (contentType.includes('application/json')) {
        try {
          req.parsedBody = JSON.parse(req.body);
        } catch (e) {
          return res.status(400).json({ error: "Invalid JSON input", details: e.message });
        }
      } else {
        try {
          req.parsedBody = await parseXml(req.body);
        } catch (e) {
          return res.status(400).json({ error: "Invalid XML input", details: e.message });
        }
      }
      
      next();
    } catch (error) {
      next(error);
    }
  },
  
  // Validate API parameters
  body('api.url').isURL(),
  body('api.method').isIn(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    .withMessage('Invalid HTTP method'),
  
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  }
];

// Helper function to safely parse JSON
function tryParseJson(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return str;
  }
}

// Helper function to process headers
function processHeaders(rawHeaders) {
  const headers = {};
  
  if (Array.isArray(rawHeaders)) {
    rawHeaders.forEach(h => {
      if (typeof h === 'string' && h.includes(':')) {
        const [key, ...value] = h.split(':');
        headers[key.trim()] = value.join(':').trim();
      }
    });
  }
  
  // Add default headers if none provided
  if (Object.keys(headers).length === 0) {
    headers['Accept'] = 'application/json';
    headers['Content-Type'] = 'application/json';
  }
  
  return headers;
}

// API proxy endpoint
app.post('/', apiLimiter, validateInput, async (req, res) => {
  try {
    const { url, method, header = [], body: postData } = req.parsedBody.api;
    const requestMethod = method.toUpperCase();

    // Prepare axios config
    const config = {
      method: requestMethod,
      url,
      headers: processHeaders(header),
      httpsAgent,
      timeout: 10000, // 10 second timeout
      maxRedirects: 5,
      validateStatus: () => true // Handle all status codes without throwing
    };

    // Process request data
    if (postData !== undefined && postData !== null && requestMethod !== 'GET' && requestMethod !== 'HEAD') {
      config.data = typeof postData === 'string' ? tryParseJson(postData) : postData;
    }

    // Make the request
    const response = await axios(config);

    // Forward response with appropriate content type
    const responseContentType = response.headers['content-type'] || 'application/octet-stream';
    res.set('Content-Type', responseContentType);
    
    // Forward status code and data
    return res.status(response.status).send(response.data);

  } catch (error) {
    console.error('Proxy error:', error);
    
    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ error: "Request timeout" });
    }
    
    if (error.code === 'ENOTFOUND') {
      return res.status(502).json({ error: "Failed to resolve host" });
    }
    
    return res.status(500).json({ 
      error: "Internal proxy error",
      details: !isProduction ? error.message : undefined
    });
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
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

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});