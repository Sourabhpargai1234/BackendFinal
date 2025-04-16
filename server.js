const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { parseString } = require('xml2js');
const https = require('https');
const helmet = require('helmet');

const app = express();

// Security middleware
app.use(helmet());

app.use(cors({
  origin: 'http://localhost', // or '*' to allow all origins (not recommended for production)
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parser configuration
app.use(bodyParser.text({
  type: ['application/json', 'application/xml', 'text/xml'],
  limit: '10mb' // Prevent large payload attacks
}));

// Reusable HTTPS agent
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  maxSockets: 100
});

// XML parser helper (moved to top for better visibility)
const parseXml = (xml) => new Promise((resolve, reject) => {
  parseString(xml, { 
    explicitArray: false, 
    ignoreAttrs: true,
    trim: true
  }, (err, result) => err ? reject(err) : resolve(result));
});

// Input validation middleware
const validateInput = (req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  
  if (!['application/json', 'application/xml', 'text/xml'].some(type => contentType.includes(type))) {
    return res.status(415).json({ error: "Unsupported Content-Type" });
  }
  
  next();
};

// API proxy endpoint
app.post('/', validateInput, async (req, res) => {
  try {
    let input;
    const contentType = req.headers['content-type'] || '';

    // Parse input based on content type
    if (contentType.includes('application/json')) {
      try {
        input = JSON.parse(req.body);
      } catch (e) {
        return res.status(400).json({ error: "Invalid JSON input", details: e.message });
      }
    } else {
      try {
        input = await parseXml(req.body);
      } catch (e) {
        return res.status(400).json({ error: "Invalid XML input", details: e.message });
      }
    }

    // Validate required fields
    if (!input?.api?.url || !input?.api?.method) {
      return res.status(400).json({ 
        error: "Missing required fields",
        required: ["api.url", "api.method"]
      });
    }

    const { url, method, header = [], body: postData } = input.api;
    const requestMethod = method.toUpperCase();

    // Validate HTTP method
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(requestMethod)) {
      return res.status(400).json({ error: "Invalid HTTP method" });
    }

    // Prepare axios config
    const config = {
      method: requestMethod,
      url,
      headers: {},
      httpsAgent,
      timeout: 10000, // 10 second timeout
      maxRedirects: 5
    };

    // Process headers
    if (Array.isArray(header)) {
      header.forEach(h => {
        if (typeof h === 'string' && h.includes(':')) {
          const [key, ...value] = h.split(':');
          config.headers[key.trim()] = value.join(':').trim();
        }
      });
    }

    // Process request data
    if (postData !== undefined && postData !== null && requestMethod !== 'GET') {
      config.data = typeof postData === 'string' ? 
        tryParseJson(postData) : 
        postData;
    }

    // Make the request
    const response = await axios(config);

    // Forward response with appropriate content type
    const responseContentType = response.headers['content-type'] || '';
    res.set('Content-Type', responseContentType.includes('json') ? 'application/json' :
      responseContentType.includes('xml') ? 'application/xml' : 'text/plain');
    
    return res.status(response.status).send(response.data);

  } catch (error) {
    console.error('Proxy error:', error);
    
    if (error.response) {
      // Forward error response from target server
      return res.status(error.response.status)
        .set(error.response.headers)
        .send(error.response.data);
    }
    
    if (error.request) {
      return res.status(504).json({ error: "No response received from target server" });
    }
    
    return res.status(500).json({ 
      error: "Internal proxy error",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Helper function to safely parse JSON
function tryParseJson(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return str;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});