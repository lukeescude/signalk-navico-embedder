const path = require('path');
const { ModuleFederationPlugin } = require('webpack').container;
const packageJson = require('./package.json');

module.exports = {
  entry: './src/configpanel/index',
  mode: 'production',
  output: {
    path: path.resolve(__dirname, 'public'),
    clean: false,
  },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        // Force javascript/auto so the ESM source compiles despite this package's
        // "type": "commonjs" (which would otherwise make webpack reject `import`).
        type: 'javascript/auto',
        loader: 'babel-loader',
        exclude: /node_modules/,
        options: { presets: ['@babel/preset-react'] },
      },
    ],
  },
  resolve: {
    extensions: ['.js', '.jsx'],
  },
  plugins: [
    new ModuleFederationPlugin({
      name: packageJson.name.replace(/[-@/]/g, '_'),
      library: { type: 'var', name: packageJson.name.replace(/[-@/]/g, '_') },
      filename: 'remoteEntry.js',
      exposes: {
        './PluginConfigurationPanel': './src/configpanel/PluginConfigurationPanel',
      },
      shared: {
        'react': { singleton: true, requiredVersion: '^19' },
        'react-dom': { singleton: true, requiredVersion: '^19' },
      },
    }),
  ],
};
