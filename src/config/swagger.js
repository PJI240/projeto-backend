const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'PIUNIVESP Backend API',
      version: '1.0.0',
      description: 'Documentação gerada pelo swagger-jsdoc'
    }
  },
  apis: ['./src/controllers/*.js', './src/routes.js'] // arquivos com JSDoc/OpenAPI
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = { swaggerUi, swaggerSpec };
