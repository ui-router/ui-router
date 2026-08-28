var webpack = require("webpack");
var path = require("path");

module.exports = {
  entry: {
    // The hosted e2e server does not rely on external CDN scripts.  Load the
    // Angular runtime zone before the application bootstrap instead.
    app: ["zone.js", "./src/main.ts"],
  },

  mode: "development",

  devtool: "cheap-module-source-map",

  output: {
    path: path.join(__dirname, "_bundles"),
    publicPath: "/_bundles/",
    filename: "[name].js",
  },

  devServer: {
    static: {
      directory: path.join(__dirname, "/"),
    },
  },

  resolve: {
    alias: {
      "@uirouter/angular$": path.resolve(
        __dirname,
        "../../../angular/uirouter-angular/dist"
      ),
      "@uirouter/angular-hybrid$": path.resolve(
        __dirname,
        "../../uirouter-angular-hybrid/dist"
      ),
    },
    extensions: [".js", ".ts"],
  },

  module: {
    rules: [{ test: /\.tsx?$/, use: ["ts-loader"] }],
  },

  externals: {
    angular: "angular",
  },
};
