angular.module('starter.services', [])

.factory('Account', function ($rootScope, UIHelper, Settings, Remote) {
	var account;
	var keysChanged = false;
	var connectionChanged = false;
	account = {
		address : 'loading',
		balance : 0,
		reserve : 20,
		transactions : [],
		otherCurrencies: []
	};

    var addToBalance = function(currency, amount){
        for(var index = 0; index < account.otherCurrencies.length; ++index) {
            var entry = account.otherCurrencies[index];
            if(entry.currency == currency)
            {
                entry.amount += amount;
                return;
            }
        }
        // no entry for currency exists -> add new entry
        account.otherCurrencies.push({currency:currency, amount:amount});             
    };

	var transactionFilter = function(msg){
		return (msg.engine_result_code == 0 && msg.type === 'transaction');
	};
	var transactionCallback = function(msg){
		account.transactions.unshift(msg.transaction);
		$rootScope.$broadcast('accountInfoLoaded');
	}
	Remote.addMessageHandler(transactionFilter, transactionCallback);
	
	var paymentFilter = function(msg){
		return (transactionFilter(msg) && msg.transaction.TransactionType === 'Payment')
	};
	var paymentCallback = function(msg){
		if (msg.transaction.Destination === account.address) {
			if (!msg.transaction.Amount.issuer) {
				console.log('payment received: ' + msg.transaction.Amount / 1000000 + ' STR');
				account.balance += parseFloat(msg.transaction.Amount) / 1000000;
			} else {
				console.log('payment received: ' + msg.transaction.Amount.value + ' ' + msg.transaction.Amount.currency);
                addToBalance(msg.transaction.Amount.currency, parseFloat(msg.transaction.Amount.value));
			}
		} 
		else if (msg.transaction.Account === account.address) {
            if(msg.transaction.SendMax)
                msg.transaction.Amount = msg.transaction.SendMax; // Hack to treat cross currency payments approximately
			if (!msg.transaction.Amount.issuer) {
				console.log('payment sent: ' + msg.transaction.Amount / 1000000 + ' STR');
				account.balance -= parseFloat(msg.transaction.Amount) / 1000000;
			} else {
				console.log('payment sent: ' + msg.transaction.Amount.value + ' ' + msg.transaction.Amount.currency);
                addToBalance(msg.transaction.Amount.currency, -parseFloat(msg.transaction.Amount.value));
			}
            $rootScope.$broadcast('paymentSuccessful');
   			UIHelper.blockScreen('Payment successful!', 2);
		}
		$rootScope.$broadcast('accountInfoLoaded');
	};	
	Remote.addMessageHandler(paymentFilter, paymentCallback);

	var successFilter = function(msg){
		return (msg.status === 'success' && msg.type === 'response' && msg.result);
	};
	var successCallback = function(msg){
		if (msg.result.account_data) {
			var newData = msg.result.account_data;
			account.balance = Math.round(parseFloat(newData.Balance) / 1000000);
		}
		else if (msg.result.lines && msg.result.account === account.address) {
            account.otherCurrencies.length = 0;
			var lines = msg.result.lines;
            for (index = 0; index < lines.length; ++index) {
                var currentLine = lines[index];
                addToBalance(currentLine.currency, parseFloat(currentLine.balance));
            }
		}
		else if (msg.result.master_seed) {
			var newKeys = msg.result;
			Settings.setKeys(newKeys.account_id, newKeys.master_seed);
		} 
        else if (msg.result.transactions) {
			var transactions = msg.result.transactions;
            account.transactions.length = 0;
			for (index = 0; index < transactions.length; ++index) {
				var currentTrx = transactions[index];
				if(currentTrx.meta && currentTrx.meta.TransactionResult === 'tesSUCCESS')
                {                    
                    if(currentTrx.tx.SendMax)
                        currentTrx.tx.Amount = currentTrx.tx.SendMax; // Hack to treat cross currency payments approximately
					account.transactions.push(currentTrx.tx);
                }
			}
		}
		$rootScope.$broadcast('accountInfoLoaded');
	};
	Remote.addMessageHandler(successFilter, successCallback);
	
	var attachToKeys = function(){
		var keys = Settings.getKeys();
		account.address = keys.address;
		// initial balance (STR)
		var data = {
			command : 'account_info',
			account : keys.address
		};
		Remote.send(data);

		// initial balance (Other Currencies)
		var data = {
			command : 'account_lines',
			account : keys.address
		};
		Remote.send(data);

		//initial transactions
		var data = {
			command : 'account_tx',
			account : keys.address,
			limit : 30
		};
		Remote.send(data);

		// subscribe for updates
		data = {
			command : 'subscribe',
			accounts : [keys.address]
		};
		Remote.send(data);		
	};
	
	Settings.get().onKeysAvailable = function () {
		if(Remote.isConnected())
			attachToKeys();
		else
			keysChanged = true;
	};

	var healthCheck = function(){
		var keys = Settings.getKeys();
		if(!keys)
			Settings.get().init();
		if(!Remote.isConnected())
		{
			Remote.init();
			connectionChanged = true;
		}
		if((keysChanged || connectionChanged) && Remote.isConnected())
		{
			attachToKeys();
			keysChanged = false;
			connectionChanged = false;
		}
	}
	
	healthCheck();
	setInterval(healthCheck, 3000);

	return {	
		get : function () {			
			return account;
		}
	}
})

.factory('Remote', function (UIHelper) {
	var createWebsocket = function(){
		try	{	
			if (!("WebSocket" in window))
			{
				UIHelper.showAlert("ws NOT supported!");
				return null;
			}
			var ws = new WebSocket('wss://test.stellar.org:9001');
			
			ws.onmessage = function(event){
				// UIHelper.showAlert(event.data);
				console.log(event.data)
				var msg = JSON.parse(event.data);
				for (var i=0; i < messageHandlers.length; i++) {
					var handler = messageHandlers[i];
					if(handler.filter(msg)) {
						handler.callback(msg);
					}
				}
			};

			ws.onerror = function () {
				UIHelper.blockScreen('Network error occurred!', 5);
			};
			ws.onclose = function () {
				console.log('ws connection closed');
			};
			
			return ws;
		}
		catch(ex){
			console.log('Network initialization failed', ex.message);
			UIHelper.showAlert(ex.message);
		}
	};
  		
	var messageHandlers = [];
	messageHandlers.add = function(filter, callback){
		messageHandlers.push( { filter: filter, callback: callback } );
	};
	
	var ignoreErrors = ['actNotFound', 'srcActNotFound'];	
	var errorFilter = function(msg) {
		if(msg.status !== 'error') return false; 		
		for(var i=0; i < ignoreErrors.length; i++){
			if(msg.error === ignoreErrors[i]) return false;
		}
		return true;
	};
	var errorCallback = function(msg) {		
		UIHelper.showAlert(msg.error_message);
	};	
	messageHandlers.add(errorFilter, errorCallback);
	
	var engineErrorFilter = function(msg) {
		if(!msg.result) return false;
		return (msg.result.engine_result_code && msg.result.engine_result_code != 0);
	};
	var engineErrorCallback = function(msg) {
		UIHelper.showAlert(msg.result.engine_result_message);
	};	
	messageHandlers.add(engineErrorFilter, engineErrorCallback);
	
	var ws = createWebsocket();
	
	return {
		isConnected : function(){
			return ws != null && ws.readyState == 1;
		},
		init : function(){
			ws = createWebsocket();
		},
		send : function (data) {
			try	{
				if(this.isConnected()) {
                    var msg = JSON.stringify(data);
                    console.log(msg);
					ws.send(msg);
                }
			}
			catch(ex){
				UIHelper.showAlert('Network communication failed: ' + ex.message);
			}
		},
		addMessageHandler: messageHandlers.add
	}
})

.factory('Settings', function (Remote) {
	var keysString = window.localStorage['keys'];

	// override for use in test network (funded)
	var testKeys = {
		address : 'gHBsnApP6wutZweigvyADvxHmwKZVkAFwY', // issuer
		secret : 's3qgYLVJQJL2eLZ54TB9msjmpRHXQBdQrmG9WbD6yVCx6NrFMYU'
	};
	var testKeysAlternative = {
		address : 'gEPLboQjouwdRBoVzi8vwLd2SWjZa3xcTL',
		secret : 'sfmB34AMuAPrgbgeFJ7iXxi14NaKxQfcXoEex3p4TqekAgvinha'
	};

//    keysString = JSON.stringify(testKeys);
//    window.localStorage['keys'] = keysString;
	var settings = this;
	var keys;

	settings.onKeysAvailable = function () {
		console.log('keys available not defined yet');
	}

	var setKeysFunc = function (addr, s) {
		keys = {
			address : addr,
			secret : s
		};
		window.localStorage['keys'] = JSON.stringify(keys);
		keys.mode = 'created';
		settings.onKeysAvailable();
	};

	settings.init = function () {
		if (!keysString) {
			// real api call
			var data = {
				command : 'create_keys'
			};
			Remote.send(data);

			// // mock with specific address
			// var mock = testKeys;
			// setKeysFunc(mock.address, mock.secret);

		} else {
			keys = JSON.parse(keysString);
			keys.mode = 'loaded';
			settings.onKeysAvailable();
		}
	};

	return {
		getKeys : function () {
			return keys;
		},

		setKeys : function (addr, s) {
			setKeysFunc(addr, s);
		},

		get : function () {
			return settings;
		}
	}
})

.factory('QR', function () {

	return {
		scan : function (success, fail) {
			if(window.cordova && window.cordova.plugins.barcodeScanner){
				// real scan on device
				cordova.plugins.barcodeScanner.scan(
					function (result) {
					success(result);
				},
					function (error) {
					if(fail)
						fail(error);
				});
			}
			else{
				// mock scan for dev purposes
				// var mockResult = { cancelled: false, text:'centaurus\\:backup001eyJhZGRyZXNzIjoiZzN2Ynl1azJyYnZMTkVkRGVrY3JFaE1xUWl4bVExUThWeiIsInNlY3JldCI6InNmRXBtMzlwdEJjWFc4c21zUnlCRnZKaWVXVGQ0WG05MUc4bkh0cGVrV2Z3UnpvZTFUUCIsIm1vZGUiOiJsb2FkZWQifQ==' };
				var mockResult = { cancelled: false, text:'gEPLboQjouwdRBoVzi8vwLd2SWjZa3xcTL' };
				success(mockResult);
			}
		}
	};
})

.factory('Commands', function (UIHelper, Settings, Account) {	

	if (typeof String.prototype.startsWith != 'function') {
		String.prototype.startsWith = function (str){
			return this.slice(0, str.length) == str;
		};
	}
	
	var knownCommands = [];
	knownCommands.add = function(commandName, callback){
		knownCommands.push( { name: commandName, callback: callback } );
	};
	
	var importKeys = function(newKeys){
		var oldKeys = Settings.getKeys();
		
		if(oldKeys.address == newKeys.address && oldKeys.secret == newKeys.secret) {
			UIHelper.showAlert('The keys have been restored correctly but did not change since your last backup.');
		}
		else {
			var doOverwrite = function(){
				Settings.setKeys(newKeys.address, newKeys.secret);
				UIHelper.showAlert('The keys have been restored');
			};

			if(Account.get().balance > 0) {
				UIHelper.confirmAndRun(
					'Overwrite Keys', 
					'This will overwrite your existing keys. If you do not have a backup, the remaining funds on the old address are lost!',
					doOverwrite
				);
			}
			else{
				doOverwrite();
			}
		}
		return true;
	}
	
	var backupCallback = function(content){
		var unmasked = atob(content);
		var newKeys = JSON.parse(unmasked);
		
		return importKeys(newKeys);
	};
	knownCommands.add('backup001', backupCallback);

	var backupCallback2 = function(content){
		UIHelper.promptForPassword(function(pwd){
			try{
				var decrypted = CryptoJS.AES.decrypt(content, pwd).toString(CryptoJS.enc.Utf8);
				var newKeys = JSON.parse(decrypted);			
				return importKeys(newKeys);		
			} catch(ex) {
				console.log(ex.message);
			}
			UIHelper.showAlert('Incorrect password!');
			return false;			
		});
	};
	knownCommands.add('backup002', backupCallback2);

	return {
		parse : function (input) {
			var result = {
				isCommand : false,
				rawCommand: ''
			}
			if(!input)
				return result;
				
			var normalized = input.replace('\\:', ':');
				
			if(normalized.startsWith('centaurus:')){
				result.isCommand =  true;
				result.rawCommand = normalized.substring(10);
			}
			return result;
		},
		
		execute : function (rawCommand) {
			var result = {
				success : false,
				commandName : 'unknownCommand'
			}			
			for (var i=0; i < knownCommands.length; i++) {
				var command = knownCommands[i];
				if(rawCommand.startsWith(command.name)) {
					result.commandName = command.name;
					result.success = command.callback(rawCommand.substring(command.name.length));					
				}
			}
		},
		
		importAddressAndSecret : function (addr, s){
			var newKeys = {
				address : addr,
				secret : s
			};
			return importKeys(newKeys);
		}		
	};
})

.factory('UIHelper', function($rootScope, $ionicLoading, $ionicPopup, $timeout){
	return {
		showAlert : function(caption){
			console.log(caption);
			$ionicLoading.hide();
			$ionicPopup.alert({
				title : caption
			})
		},
		promptForPassword : function(onOk){
			$ionicPopup.prompt({
				title: 'Enter Password',
				inputType: 'password',
				inputPlaceholder: 'Your password'
			}).then(function(res) {
				if(res || res == ''){
					onOk(res)
				}
			});			
		},
		confirmAndRun : function(caption, text, onConfirm){
			$ionicLoading.hide();
			var popup = $ionicPopup.confirm({
				title : caption,
				template : text
			});
			popup.then(function(res){
				if(res){
					onConfirm();
				}
			});
		},
		blockScreen: function(text, timeoutSec){
			$ionicLoading.show({
				template : text
			});
			$timeout(function () {
				$ionicLoading.hide();
			}, timeoutSec * 1000);
		},
		shareText: function(caption, text){
			if(window.plugins){
				window.plugins.socialsharing.share(text, caption);
			}
			else{
				var subject = caption.replace(' ', '%20').replace('\n', '%0A');
				var body = text.replace(' ', '%20').replace('\n', '%0A');
				window.location.href = 'mailto:?subject=' + subject + '&body=' + body;
			}
		}
	};
})