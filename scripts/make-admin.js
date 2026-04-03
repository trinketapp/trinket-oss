#!/usr/bin/env node
/**
 * Make a user an admin
 * Usage: node scripts/make-admin.js <email>
 *
 * This script grants the 'admin' role to an existing user.
 * The user must already have an account.
 */

var mongoose = require('mongoose');
var _ = require('underscore');

var email = process.argv[2];

if (!email) {
  console.error('Usage: node scripts/make-admin.js <email>');
  console.error('Example: node scripts/make-admin.js admin@example.com');
  process.exit(1);
}

// Connect to database
require('../config/db');

// Load User model and Roles
var User = require('../lib/models/user');
var Roles = require('../lib/models/roles');

function makeAdmin() {
  // findByLogin searches by email or username
  User.findByLogin(email.toLowerCase(), function (err, user) {
    if (err) {
      console.error('Database error:', err.message);
      process.exit(1);
    }

    if (!user) {
      console.error('User not found with email:', email);
      console.error('Make sure the user has registered first.');
      process.exit(1);
    }

    // Check if already admin
    if (user.hasRole('admin')) {
      console.log('User', user.email, 'is already an admin.');
      process.exit(0);
    }

    Roles.getPermissions('admin')
      .then(function (permissions) {
        console.log('Got admin permissions');

        // Find site context or create it
        var siteRoleIndex = _.findIndex(user.roles, function (r) {
          return r.context === 'site';
        });

        if (siteRoleIndex >= 0) {
          console.log('Found existing site role');
          if (user.roles[siteRoleIndex].roles.indexOf('admin') < 0) {
            user.roles[siteRoleIndex].roles.push('admin');
          }
          user.roles[siteRoleIndex].permissions = _.union(
            user.roles[siteRoleIndex].permissions || [],
            permissions || [],
          );
        } else {
          console.log('creating new site role entry');
          user.roles.push({
            context: 'site',
            roles: ['admin'],
            permissions: permissions || [],
            thru: {},
            limits: {},
          });
        }

        return user.save();
      })
      .then(function (savedUser) {
        console.log('Success! User', savedUser.email, 'is now an admin.');
        console.log('They can access /admin after logging in.');
        process.exit(0);
      })
      .catch(function (err) {
        console.error('Error:', err.message);
        process.exit(1);
      });
  });
}

// Handle connection - may already be open or connecting
if (mongoose.connection.readyState === 1) {
  makeAdmin();
} else {
  mongoose.connection.once('open', makeAdmin);
}

mongoose.connection.on('error', function (err) {
  console.error('MongoDB connection error:', err.message);
  console.error('Make sure MongoDB is running.');
  process.exit(1);
});
