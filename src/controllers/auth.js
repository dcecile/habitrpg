var _ = require('lodash');
var validator = require('validator');
var check = validator.check;
var sanitize = validator.sanitize;
var passport = require('passport');
var helpers = require('habitrpg-shared/script/helpers');
var async = require('async');
var utils = require('../utils');
var nconf = require('nconf');
var User = require('../models/user').model;
var Stats = require('../models/stats').model;

var api = module.exports;

var NO_TOKEN_OR_UID = { err: "You must include a token and uid (user id) in your request"};
var NO_USER_FOUND = {err: "No user found."};
var NO_SESSION_FOUND = { err: "You must be logged in." };

/*
 beforeEach auth interceptor
 */

api.auth = function(req, res, next) {
  var token, uid;
  uid = req.headers['x-api-user'];
  token = req.headers['x-api-key'];
  if (!(uid && token)) return res.json(401, NO_TOKEN_OR_UID);
  User.findOne({_id: uid,apiToken: token}, function(err, user) {
    if (err) return res.json(500, {err: err});
    if (_.isEmpty(user)) return res.json(401, NO_USER_FOUND);

    // Remove this after a few days. Users aren't refreshing after the pets roll out, which is required
    if (_.find(req.body, function(v){return v && v.data && _.isArray(v.data['items.pets'])})) {
      // simply discard the update. Unfortunately, sending an error will keep their set ops in the sync queue.
      return res.json(200, {_v: user._v-1});
    }

    res.locals.wasModified = req.query._v ? +user._v !== +req.query._v : true;
    res.locals.user = user;
    req.session.userId = user._id;
    return next();
  });
};

api.authWithSession = function(req, res, next) { //[todo] there is probably a more elegant way of doing this...
  var uid;
  uid = req.session.userId;
  if (!(req.session && req.session.userId)) {
    return res.json(401, NO_SESSION_FOUND);
  }
  return User.findOne({_id: uid,}, function(err, user) {
    if (err) return res.json(500, {err: err});
    if (_.isEmpty(user)) return res.json(401, NO_USER_FOUND);
    res.locals.user = user;
    return next();
  });
};

api.registerUser = function(req, res, next) {
  var confirmPassword, e, email, password, username, _ref;
  _ref = req.body, email = _ref.email, username = _ref.username, password = _ref.password, confirmPassword = _ref.confirmPassword;
  if (!(username && password && email)) {
    return res.json(401, {err: ":username, :email, :password, :confirmPassword required"});
  }
  if (password !== confirmPassword) {
    return res.json(401, {err: ":password and :confirmPassword don't match"});
  }
  try {
    validator.check(email).isEmail();
  } catch (err) {
    return res.json(401, {err: err.message});
  }
  async.waterfall([
    function(cb) {
      User.findOne({'auth.local.email': email}, cb);
    },
    function(found, cb) {
      if (found) {
        return cb("Email already taken");
      }
      User.findOne({'auth.local.username': username}, cb);
    }, function(found, cb) {
      var newUser, salt, user;
      if (found) {
        return cb("Username already taken");
      }
      newUser = helpers.newUser(true);
      salt = utils.makeSalt();
      newUser.auth = {
        local: {
          username: username,
          email: email,
          salt: salt
        },
        timestamps: {created: +new Date(), loggedIn: +new Date()}
      };
      newUser.auth.local.hashed_password = utils.encryptPassword(password, salt);
      user = new User(newUser);
      user.save(cb);
      Stats.updateStats(); // async in background
    }
  ], function(err, saved) {
    if (err) {
      return res.json(401, {err: err});
    }
    res.json(200, saved);
  });
};

/*
 Register new user with uname / password
 */


api.loginLocal = function(req, res, next) {
  var username = req.body.username;
  var password = req.body.password;
  if (!(username && password)) return res.json(401, {err:'Missing :username or :password in request body, please provide both'});
  User.findOne({'auth.local.username': username}, function(err, user){
    if (err) return res.json(500,{err:err});
    if (!user) return res.json(401, {err:"Username '" + username + "' not found. Usernames are case-sensitive, click 'Forgot Password' if you can't remember the capitalization."});
    // We needed the whole user object first so we can get his salt to encrypt password comparison
    User.findOne({
      'auth.local.username': username,
      'auth.local.hashed_password': utils.encryptPassword(password, user.auth.local.salt)
    }, function(err, user){
      if (err) return res.json(500,{err:err});
      if (!user) return res.json(401,{err:'Incorrect password'});
      res.json({id: user._id,token: user.apiToken});
    });
  });
};

/*
 POST /user/auth/facebook
 */


api.loginFacebook = function(req, res, next) {
  var email, facebook_id, name, _ref;
  _ref = req.body, facebook_id = _ref.facebook_id, email = _ref.email, name = _ref.name;
  if (!facebook_id) {
    return res.json(401, {
      err: 'No facebook id provided'
    });
  }
  return User.findOne({
    'auth.local.facebook.id': facebook_id
  }, function(err, user) {
    if (err) {
      return res.json(401, {
        err: err
      });
    }
    if (user) {
      return res.json(200, {
        id: user.id,
        token: user.apiToken
      });
    } else {
      /* FIXME: create a new user instead*/

      return res.json(403, {
        err: "Please register with Facebook on https://habitrpg.com, then come back here and log in."
      });
    }
  });
};

api.resetPassword = function(req, res, next){
  var email = req.body.email,
    salt = utils.makeSalt(),
    newPassword =  utils.makeSalt(), // use a salt as the new password too (they'll change it later)
    hashed_password = utils.encryptPassword(newPassword, salt);

  User.findOne({'auth.local.email':email}, function(err, user){
    if (err) return res.json(500,{err:err});
    if (!user) return res.send(500, {err:"Couldn't find a user registered for email " + email});
    user.auth.local.salt = salt;
    user.auth.local.hashed_password = hashed_password;
    utils.sendEmail({
      from: "HabitRPG <admin@habitrpg.com>",
      to: email,
      subject: "Password Reset for HabitRPG",
      text: "Password for " + user.auth.local.username + " has been reset to " + newPassword + ". Log in at " + nconf.get('BASE_URL'),
      html: "Password for <strong>" + user.auth.local.username + "</strong> has been reset to <strong>" + newPassword + "</strong>. Log in at " + nconf.get('BASE_URL')
    });
    user.save();
    return res.send('New password sent to '+ email);
  });
};

api.changePassword = function(req, res, next) {
  var user = res.locals.user,
    oldPassword = req.body.oldPassword,
    newPassword = req.body.newPassword,
    confirmNewPassword = req.body.confirmNewPassword;

  if (newPassword != confirmNewPassword)
    return res.json(500, {err: "Password & Confirm don't match"});

  var salt = user.auth.local.salt,
    hashed_old_password = utils.encryptPassword(oldPassword, salt),
    hashed_new_password = utils.encryptPassword(newPassword, salt);

  if (hashed_old_password !== user.auth.local.hashed_password)
    return res.json(500, {err:"Old password doesn't match"});

  user.auth.local.hashed_password = hashed_new_password;
  user.save(function(err, saved){
    if (err) res.json(500,{err:err});
    res.send(200);
  })
}

/*
 Registers a new user. Only accepting username/password registrations, no Facebook
 */

api.setupPassport = function(router) {

  router.get('/logout', function(req, res) {
    req.logout();
    delete req.session.userId;
    res.redirect('/');
  })

  // GET /auth/facebook
  //   Use passport.authenticate() as route middleware to authenticate the
  //   request.  The first step in Facebook authentication will involve
  //   redirecting the user to facebook.com.  After authorization, Facebook will
  //   redirect the user back to this application at /auth/facebook/callback
  router.get('/auth/facebook',
    passport.authenticate('facebook'),
    function(req, res){
      // The request will be redirected to Facebook for authentication, so this
      // function will not be called.
    });

  // GET /auth/facebook/callback
  //   Use passport.authenticate() as route middleware to authenticate the
  //   request.  If authentication fails, the user will be redirected back to the
  //   login page.  Otherwise, the primary route function function will be called,
  //   which, in this example, will redirect the user to the home page.
  router.get('/auth/facebook/callback',
    passport.authenticate('facebook', { failureRedirect: '/login' }),
    function(req, res) {
      //res.redirect('/');

      async.waterfall([
        function(cb){
          User.findOne({'auth.facebook.id':req.user.id}, cb)
        },
        function(user, cb){
          if (user) return cb(null, user);
          var newUser = helpers.newUser(true);
          newUser.auth = {
            facebook: req.user,
            timestamps: {created: +new Date(), loggedIn: +new Date()}
          };
          user = new User(newUser);
          user.save(cb);


        }
      ], function(err, saved){
        if (err) return res.redirect('/static/front?err=' + err);
        req.session.userId = saved._id;
        res.redirect('/static/front?_id='+saved._id+'&apiToken='+saved.apiToken);
      })
    });

  // Simple route middleware to ensure user is authenticated.
  //   Use this route middleware on any resource that needs to be protected.  If
  //   the request is authenticated (typically via a persistent login session),
  //   the request will proceed.  Otherwise, the user will be redirected to the
  //   login page.
//  function ensureAuthenticated(req, res, next) {
//    if (req.isAuthenticated()) { return next(); }
//    res.redirect('/login')
//  }
};
