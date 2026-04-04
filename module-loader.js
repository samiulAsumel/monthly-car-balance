// Module Loader for Monthly Car Balance
// Exposes modular functionality to the legacy monolithic script

// Create global window object for modules
window.CarBalanceModules = {};

// Load Firebase configuration
try {
  // Import getFirebaseConfig from ESM module (loaded via script type="module")
  // This assumes the config module is loaded separately
  console.info('Module loader: Setting up Firebase config access');
  
  window.getFirebaseConfig = function() {
    // Check if environment variables are available
    if (window.ENV && window.ENV.FIREBASE_DATABASE_URL) {
      return {
        apiKey: window.ENV.FIREBASE_API_KEY,
        authDomain: window.ENV.FIREBASE_AUTH_DOMAIN,
        databaseURL: window.ENV.FIREBASE_DATABASE_URL,
        projectId: window.ENV.FIREBASE_PROJECT_ID,
        storageBucket: window.ENV.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: window.ENV.FIREBASE_MESSAGING_SENDER_ID,
        appId: window.ENV.FIREBASE_APP_ID,
        measurementId: window.ENV.FIREBASE_MEASUREMENT_ID
      };
    }
    
    // Fallback - app works locally only, no cloud sync
    console.warn('⚠️ Firebase config missing! Add config.js for cloud storage.');
    return {
      databaseURL: "https://monthly-car-balance-default-rtdb.asia-southeast1.firebasedatabase.app/"
    };
  };
  
  console.info('Module loader: Firebase config function created');
} catch (error) {
  console.error('Module loader: Failed to setup Firebase config:', error);
  window.getFirebaseConfig = function() {
    return { databaseURL: null };
  };
}

// Authentication Manager proxy
try {
  console.info('Module loader: Setting up authentication manager');
  
  // Simplified auth manager that matches the interface expected by script-full.js
  window.authManager = {
    isLoggedIn: false,
    currentUser: null,
    
    // Initialize authentication
    init: function() {
      const savedUser = localStorage.getItem('car_balance_current_user');
      if (savedUser) {
        try {
          const user = JSON.parse(savedUser);
          if (user.expiry > Date.now()) {
            this.currentUser = user.username;
            this.isLoggedIn = true;
            return true;
          }
        } catch (error) {
          console.error('Failed to parse saved user:', error);
        }
      }
      
      // Clear expired session
      localStorage.removeItem('car_balance_current_user');
      this.currentUser = null;
      this.isLoggedIn = false;
      return false;
    },
    
    // Authenticate user
    authenticate: function(username, password) {
      // Get stored users
      const usersData = localStorage.getItem('car_balance_users');
      if (!usersData) return false;
      
      try {
        const users = JSON.parse(usersData);
        // Simple password check (in production, use proper hashing)
        const user = users.find(u => u.username === username && u.password === password);
        
        if (user) {
          // Create session
          const session = {
            username: username,
            expiry: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
          };
          
          localStorage.setItem('car_balance_current_user', JSON.stringify(session));
          this.currentUser = username;
          this.isLoggedIn = true;
          return true;
        }
      } catch (error) {
        console.error('Authentication error:', error);
      }
      
      return false;
    },
    
    // Logout user
    logout: function() {
      localStorage.removeItem('car_balance_current_user');
      this.currentUser = null;
      this.isLoggedIn = false;
      return true;
    },
    
    // Check if user is admin
    isAdmin: function() {
      return this.currentUser === 'admin';
    },
    
    // Get current username
    getUsername: function() {
      return this.currentUser;
    }
  };
  
  // Initialize auth manager
  window.authManager.init();
  console.info('Module loader: Authentication manager initialized');
} catch (error) {
  console.error('Module loader: Failed to setup authentication manager:', error);
}

// Utility functions from calculations module
try {
  console.info('Module loader: Setting up calculation utilities');
  
  window.CarBalanceModules.Calculations = {
    LOCS: ["SAS", "CHC", "CMU", "CTY", "CCT", "CSL", "SKS", "CSD"],
    
    mk: (y, m) => `${y}-${String(m).padStart(2, "0")}`,
    
    dIn: (y, m) => new Date(y, m, 0).getDate(),
    
    dow: (s) => new Date(s + "T00:00:00").getDay(),
    
    fmt: (n) => (Number.isFinite(n) ? n.toLocaleString() : "—"),
    
    pct: (a, b) => (b ? Math.round(((a - b) / b) * 100) : null),
    
    calcLocBals: function(prevBal, del, imp) {
      if (!prevBal || !del || !imp || prevBal.length !== 8 || del.length !== 8 || imp.length !== 8) {
        return new Array(8).fill(0);
      }
      
      const result = [];
      for (let i = 0; i < 8; i++) {
        const prev = prevBal[i] || 0;
        const delivery = del[i] || 0;
        const importAmt = imp[i] || 0;
        result[i] = prev - delivery + importAmt;
      }
      return result;
    },
    
    calcCumulative: function(balances, deliveries, imports) {
      const totals = {
        balance: 0,
        delivery: 0,
        import: 0,
        closing: 0
      };
      
      if (!balances || !deliveries || !imports) return totals;
      
      for (let i = 0; i < 8; i++) {
        totals.balance += balances[i] || 0;
        totals.delivery += deliveries[i] || 0;
        totals.import += imports[i] || 0;
      }
      
      totals.closing = totals.balance - totals.delivery + totals.import;
      return totals;
    },
    
    validateRowData: function(row) {
      const errors = [];
      
      if (!row.date || typeof row.date !== 'string') {
        errors.push('Invalid date format');
      }
      
      if (!Array.isArray(row.del) || row.del.length !== 8) {
        errors.push('Delivery data must be an array of 8 numbers');
      }
      
      if (!Array.isArray(row.imp) || row.imp.length !== 8) {
        errors.push('Import data must be an array of 8 numbers');
      }
      
      if (!Array.isArray(row.bal) || row.bal.length !== 8) {
        errors.push('Balance data must be an array of 8 numbers');
      }
      
      return {
        valid: errors.length === 0,
        errors: errors
      };
    }
  };
  
  console.info('Module loader: Calculation utilities loaded');
} catch (error) {
  console.error('Module loader: Failed to setup calculation utilities:', error);
}

// Error handling utilities
window.CarBalanceModules.ErrorHandler = {
  showError: function(message) {
    console.error('Application Error:', message);
    // Fallback UI notification (could be enhanced)
    alert('Error: ' + message);
  },
  
  showWarning: function(message) {
    console.warn('Application Warning:', message);
  },
  
  showSuccess: function(message) {
    console.log('Application Success:', message);
    // Fallback UI notification
    alert('Success: ' + message);
  },
  
  handleFirebaseError: function(error) {
    console.error('Firebase Error:', error);
    return 'Cloud sync failed: ' + (error.message || 'Unknown error');
  }
};

console.info('Module loader initialization complete');