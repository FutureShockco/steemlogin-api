const { createHash } = require('crypto');
const { intersection, has } = require('lodash');
const { verify } = require('./token');
const { getAppProfile, b64uToB64 } = require('./utils');
const client = require('./client');
const config = require('../config.json');
const blacklist = ['woxauto']
/**
 * Check if user allow app proxy account to post on his behalf
 * And if app allow @steemconnect to post on his behalf
 */
const verifyPermissions = async (req, res, next) => {
  let accounts;
  try {
    accounts = await client.database.getAccounts([req.proxy, req.user]);
  } catch (e) {
    console.error('Unable to load accounts from steemd', req.proxy, req.user, e);
  }
  console.log(req.proxy)
  if(blacklist.includes(req.proxy))
  {
    res.status(401).json({
      error: 'unauthorized_client',
      error_description: `The app @${req.proxy} has been reported for suspicious activities.`,
    });
  }
  else if (!has(accounts, '[0].name') || !has(accounts, '[1].name')) {
    res.status(401).json({
      error: 'unauthorized_client',
      error_description: `The app @${req.proxy} or user @${req.user} account failed to load`,
    });
  } else {
    const userAccountAuths = accounts[1].posting.account_auths.map((account) => account[0]);
    if (userAccountAuths.indexOf(req.proxy) === -1) {
      res.status(401).json({
        error: 'unauthorized_client',
        error_description: `The app @${req.proxy} doesn't have permission to broadcast for @${req.user}`,
      });
    } else {
      const appAccountAuths = accounts[0].posting.account_auths.map((account) => account[0]);
      if (appAccountAuths.indexOf(process.env.BROADCASTER_USERNAME) === -1) {
        res.status(401).json({
          error: 'unauthorized_client',
          error_description: `Broadcaster account doesn't have permission to broadcast for @${req.proxy}`,
        });
      } else {
        next();
      }
    }
  }
};

const strategy = (req, res, next) => {

  let authorization = req.get('authorization');
  if (authorization) authorization = authorization.replace(/^(Bearer|Basic)\s/, '').trim();
  const token = authorization
    || req.query.access_token
    || req.body.access_token
    || req.query.code
    || req.body.code
    || req.query.refresh_token
    || req.body.refresh_token;

  if (token) {
    try {
      const decoded = Buffer.from(b64uToB64(token), 'base64').toString();
      const tokenObj = JSON.parse(decoded);
      const signedMessage = tokenObj.signed_message;
      if (
        tokenObj.authors
        && tokenObj.authors[0]
        && tokenObj.signatures
        && tokenObj.signatures[0]
        && signedMessage
        && signedMessage.type
        && ['login', 'posting', 'offline', 'code', 'refresh']
          .includes(signedMessage.type)
        && signedMessage.app
      ) {
        const message = JSON.stringify({
          signed_message: signedMessage,
          authors: tokenObj.authors,
          timestamp: tokenObj.timestamp,
        });
        const username = tokenObj.authors[0];
        verify(message, username, tokenObj.signatures[0], (err, isValid) => {
          if (!err && isValid) {
            console.log('Token signature is valid', username);
            let scope;
            if (signedMessage.type === 'login') scope = ['login'];
            if (['posting', 'offline', 'code', 'refresh']
              .includes(signedMessage.type)) scope = config.authorized_operations;
            let role = 'app';
            if (signedMessage.type === 'code') role = 'code';
            if (signedMessage.type === 'refresh') role = 'refresh';
            /* eslint-disable no-param-reassign */
            req.token = token;
            req.role = role;
            req.user = username;
            req.proxy = signedMessage.app;
            req.scope = scope;
            req.type = 'signature';
            /* eslint-enable no-param-reassign */
          }
          next();
        });
      } else {
        next();
      }
    } catch (e) {
      console.log('Token signature decoding failed', e);
      next();
    }
  } else {
    next();
  }
};

const authenticate = (roles) => async (req, res, next) => {
  const role = Array.isArray(roles) && req.role && roles.includes(req.role)
    ? req.role : roles;

  if (!req.role || (role && req.role !== role)) {
    res.status(401).json({
      error: 'invalid_grant',
      error_description: 'The token has invalid role',
    });
  } else if (['code', 'refresh'].includes(req.role)) {
    let app;
    try {
      app = await getAppProfile(req.proxy);
    } catch (e) {
      console.error('Failed to get app profile', e);
    }

    const secret = req.query.client_secret || req.body.client_secret;
    const secretHash = createHash('sha256').update(secret).digest('hex');

    if (!app.secret || secretHash !== app.secret) {
      res.status(401).json({
        error: 'invalid_grant',
        error_description: 'The code or secret is not valid',
      });
    } else if (app.allowed_ips && app.allowed_ips.length > 0) {
      const reqIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
      if (intersection(app.allowed_ips, reqIp.replace(' ', '').split(',')).length > 0) {
        next();
      } else {
        res.status(401).json({
          error: 'unauthorized_access',
          error_description: `The IP ${reqIp} is not authorized`,
        });
      }
    } else {
      next();
    }
  } else {
    next();
  }
};

module.exports = {
  verifyPermissions,
  strategy,
  authenticate,
};
