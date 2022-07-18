const mysql = require('mysql2/promise');
const { Kafka } = require("kafkajs");
const fastcsv = require('fast-csv');

/*This file handles Kafka messaging and database updates*/
// const socketIO=require('socket.io');
// const http=require('http')

let dbConfig = {
    host: 'db_disp_atl', //change to localhost for local usage
    //host: 'localhost',
    port: 3306, //change to 3306-3307
    //port: 3307,
    user: 'root',
    //password: '12345',
    database: 'display_atl' //actual database name
}

/*Users database configuration (database is synced with login and choose display MS which manages users)*/
let dbConfig_for_users = {
    //host: 'localhost',
    host: 'db_disp_atl',
    //port: 3307,
    port: 3306,
    user: 'root',
    password: '',
    database: 'user_management'
}

let plot_parameter = 0;
module.exports = {plot_parameter : "0"};

/* listen to kafka topic ATL and update when needed*/
async function updateDatabase(URI) {
    /*wrap everything in a promise to make sure this function has finished execution before we begin handling the next message received*/
    return new Promise (async(resolve, reject) => {

        let URIparts = URI.toString().split('/');
        let filename = URIparts[URIparts.length - 1];
        //console.log(filename);

        let filename_split = filename.split('_');
        let new_file_name = filename_split[0] + '_' + filename_split[1] + '_' + filename_split[2] + '_' + filename_split[3] + '_' +
            'dataForDisplay.csv';
        //console.log(new_file_name);

        let currentYearMonth = filename_split[0] + '-' + filename_split[1] + '-01 00:00:00.000'

        /* every time we have an update :
         * step 1: delete all the existing records
         * step 2: insert the new records
        */
        /*we create a connection with the database*/
        let our_dbConn = await mysql.createConnection(dbConfig);


        /*delete tuples referencing the same month as the file we received since they will be re-inserted (maybe even fill in gaps that existed)*/
        let clear = `DELETE FROM actual_total_load WHERE \`DateTime\` >= \'${currentYearMonth}\' `;
        //console.log(clear);
        let result = await our_dbConn.execute(clear);

        /*reset the auto increment table_index so that it will not get very large with deletes and re-insertions.
        We wait for the previous queries to finish their execution before issuing the next and the inserts*/
        let resetIndex = 'ALTER TABLE actual_total_load AUTO_INCREMENT = 0;';
        result = await our_dbConn.execute(resetIndex);

        //  console.log(result);

        fastcsv
            .parseFile(URI)
            .on('data', async (row) => {
                let row_split = JSON.stringify(row).split('\\t');
                //console.log(row_split);
                let dateTime = row_split[0].substring(2); //maybe cut off miliseconds from dateTime
                let mapCode = row_split[1];
                let totalLoadValue = row_split[2];
                let resolutionCode = row_split[3].slice(0, -2);
                /*enter the data into the database*/
                /*First we prepare the sql query with the values we read from the csv*/
                let sql = `INSERT INTO actual_total_load (dateTime, mapCode, totalLoadValue, resolutionCode)` +
                    ` VALUES(\'${dateTime}\', \'${mapCode}\', \'${totalLoadValue}\', \'${resolutionCode}\') `;
                //console.log(sql);
                /*then we execute the query without blocking and waiting for each individual query to finish*/
                result = our_dbConn.query(sql);
                //  console.log(result);

            })
            .on('end', async (rowCount) => {
                await result;

                console.log(`Front-end updated with ${rowCount} tuples!`)
                our_dbConn.destroy();
                resolve('done');

            });
    })
}

/* .... .........        KAFKA consumer ..... ........... ........                          */
/* ... display consumes the message from split microservice                                 */
/* the message is the URI where from the display microservice will get the new data to plot */
/*..........................................................................................*/
const kafka = new Kafka({
    clientId: 'my-consumer',
    /*container and port where kafka broker is listenting*/
    brokers: ['kafka:29090'] //change kafka:29090 to localhost:9092 to run locally
    //brokers: ['localhost:9092'],
});
/*we need a large sessionTimeout because for huge data insertions to database the consumer will block for a long time and we cannot have it being removed from kafka group*/
const consumer = kafka.consumer({ groupId: 'pop-to-disp-atl-group', sessionTimeout: 3500000 });
/*this consumer consumes from two topics. One regarding the actual physical flow data from populate MS,*/
/*and one regarding user data from login and choose display MS*/
const topic_cons = 'pop_to_disp_ATL';
const topic_users = 'users_topic';

module.exports = {
    run:  async () => {
        // Consuming
        /*Connect the consumer and subscribe him to both topics*/
        await consumer.connect();

        await consumer.subscribe({topics: [topic_cons, topic_users]});

        await consumer.run({
            eachMessage: async ({topic, partition, message}) => {
                /*if it originates from physical flow data topic update the ff database and wait for update to finish before reading a new message*/
                if(topic == topic_cons) {
                    console.log(`received message: ${message.value}`);
                    await updateDatabase(message.value);
                    /* now it's time to update the diagrams in frontend !!
                    !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
                     */
                    /*change the value of the variable to signal that new data came and the diagram must be updated*/
                    if(plot_parameter == 1){
                        plot_parameter = 0;
                        module.exports = {plot_parameter : "0"};
                    }
                    else{
                        plot_parameter = 1;
                        module.exports = {plot_parameter : "1"};
                    }
                }
                /*if it originates from users topic...*/
                else if (topic == topic_users) {
                    let user_info = message.value.toString().split('/');
                    let our_users_dbConn = await mysql.createConnection(dbConfig_for_users);
                    /*if it is a message for a new user insertion...*/
                    if(user_info[0] == 'insert') {
                        let email = user_info[1];
                        let first_name = user_info[2];
                        let last_name = user_info[3];
                        /*attempt to insert him in the users database*/
                        let sql = `INSERT INTO users (email, first_name, last_name, license_expiration_date, last_login)` +
                            ` VALUES(\'${email}\', \'${first_name}\', \'${last_name}\', DATE_ADD(current_timestamp(), INTERVAL 30 DAY) , current_timestamp())`;
                        console.log(sql);
                        try {
                            let result = await our_users_dbConn.query(sql);
                        }
                            /*if he already exists there (probably because login and choose display MS crashed and lost it's own database) update his last login field*/
                        catch {
                            console.log('user already exists locally. Maybe update his license.')
                            let sql = `SELECT * FROM users WHERE email = \'${email}\'`;
                            console.log(sql);

                            /*get the expiration date to use the same on the Update query so that the dafault currentTimestamp() value will not be used*/
                            let [rows, fields] = await our_users_dbConn.query(sql);
                            if(rows.length != 0) {
                                let rec_date = new Date(rows[0].license_expiration_date);
                                rec_date.setMonth(rec_date.getMonth() + 1);
                                let expiration_date = rec_date.getFullYear() + "-";

                                if (rec_date.getMonth() < 10) {
                                    expiration_date += "0" + rec_date.getMonth() + "-";
                                } else {
                                    expiration_date += rec_date.getMonth() + "-";
                                }

                                if (rec_date.getDate() < 10) {
                                    expiration_date += "0" + rec_date.getDate() + " ";
                                } else {
                                    expiration_date += rec_date.getDate() + " ";
                                }

                                if (rec_date.getHours() < 10) {
                                    expiration_date += "0" + rec_date.getHours() + ":";
                                } else {
                                    expiration_date += rec_date.getHours() + ":";
                                }

                                if (rec_date.getMinutes() < 10) {
                                    expiration_date += "0" + rec_date.getMinutes() + ":";
                                } else {
                                    expiration_date += rec_date.getMinutes() + ":";
                                }

                                if (rec_date.getSeconds() < 10) {
                                    expiration_date += "0" + rec_date.getSeconds();
                                } else {
                                    expiration_date += rec_date.getSeconds();
                                }

                                sql = `UPDATE users SET last_login = current_timestamp(), license_expiration_date = \'${expiration_date}' WHERE email = \'${email}\'`;
                                console.log(sql);

                                let query = await our_users_dbConn.query(sql);
                            }
                        }

                    }
                    /*if it is a message for updating the last login field*/
                    else if (user_info[0] == 'update') {
                        /*it will contain the previous expiration date and the email to update the users database setting the last login to currentTimestamp()*/
                        let expiration_date = user_info[1];
                        let requested_email = user_info[2];

                        let sql = `UPDATE users SET last_login = current_timestamp(), license_expiration_date = \'${expiration_date}' WHERE email = \'${requested_email}\'`;
                        console.log(sql);
                        try {
                            let result = await our_users_dbConn.query(sql);
                        }
                        catch (err){
                            console.log(err);
                            console.log('user doesn\'t exist here. This is probably caused by a db crash.');
                        }
                    }
                    /*if it is a message for extending the license of a user with a valid license*/
                    else if (user_info[0] == 'updateExists') {
                        let expiration_date = user_info[1];
                        let days_extend = user_info[2];
                        let requested_email = user_info[3];

                        let sql = `UPDATE users SET license_expiration_date = DATE_ADD(\'${expiration_date}\', INTERVAL \'${days_extend}\' DAY) WHERE email = \'${requested_email}\'`;
                        let result = await our_users_dbConn.query(sql);
                    }
                    /*if it is a message for extending (essentially granting him a license) the license of a user with an expired license*/
                    else if (user_info[0] == 'updateNotExists') {
                        /*we receive the period for which he wants to be licensed and his email and grant him a license for this period starting immediately*/
                        let days_extend = user_info[1];
                        let requested_email = user_info[2];

                        let sql = `UPDATE users SET license_expiration_date = DATE_ADD(current_timestamp(), INTERVAL \'${days_extend}\' DAY) WHERE email = \'${requested_email}\'`;
                        let result = await our_users_dbConn.query(sql);
                    }
                    /*destroy the connection to the database*/
                    our_users_dbConn.destroy();
                }
            },
        })
    }
}

