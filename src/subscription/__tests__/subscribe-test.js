/**
 *  Copyright (c) 2015, Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the BSD-style license found in the
 *  LICENSE file in the root directory of this source tree. An additional grant
 *  of patent rights can be found in the PATENTS file in the same directory.
 */

import { expect } from 'chai';
import { describe, it } from 'mocha';
import EventEmitter from 'events';
import eventEmitterAsyncIterator from './eventEmitterAsyncIterator';
import { subscribe } from '../subscribe';
import { parse } from '../../language';
import { GraphQLError } from '../../error/GraphQLError';
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLList,
  GraphQLBoolean,
  GraphQLInt,
  GraphQLString,
} from '../../type';

const EmailType = new GraphQLObjectType({
  name: 'Email',
  fields: {
    from: { type: GraphQLString },
    subject: { type: GraphQLString },
    message: { type: GraphQLString },
    unread: { type: GraphQLBoolean },
  }
});

const InboxType = new GraphQLObjectType({
  name: 'Inbox',
  fields: {
    total: {
      type: GraphQLInt,
      resolve: inbox => inbox.emails.length,
    },
    unread: {
      type: GraphQLInt,
      resolve: inbox => inbox.emails.filter(email => email.unread).length,
    },
    emails: { type: new GraphQLList(EmailType) },
  }
});

const QueryType = new GraphQLObjectType({
  name: 'Query',
  fields: {
    inbox: { type: InboxType },
  }
});

const EmailEventType = new GraphQLObjectType({
  name: 'EmailEvent',
  fields: {
    email: { type: EmailType },
    inbox: { type: InboxType },
  }
});

const emailSchema = emailSchemaWithResolvers();

function emailSchemaWithResolvers(subscribeFn, resolveFn) {
  return new GraphQLSchema({
    query: QueryType,
    subscription: new GraphQLObjectType({
      name: 'Subscription',
      fields: {
        importantEmail: {
          type: EmailEventType,
          resolve: resolveFn,
          subscribe: subscribeFn,
        },
      },
    })
  });
}

async function createSubscription(pubsub, schema = emailSchema, ast) {
  const data = {
    inbox: {
      emails: [
        {
          from: 'joe@graphql.org',
          subject: 'Hello',
          message: 'Hello World',
          unread: false,
        },
      ],
    },
    importantEmail() {
      return eventEmitterAsyncIterator(pubsub, 'importantEmail');
    }
  };

  function sendImportantEmail(newEmail) {
    data.inbox.emails.push(newEmail);
    // Returns true if the event was consumed by a subscriber.
    return pubsub.emit('importantEmail', {
      importantEmail: {
        email: newEmail,
        inbox: data.inbox,
      }
    });
  }

  const defaultAst = parse(`
    subscription ($priority: Int = 0) {
      importantEmail(priority: $priority) {
        email {
          from
          subject
        }
        inbox {
          unread
          total
        }
      }
    }
  `);

  // `subscribe` returns Promise<AsyncIterator | Error | ExecutionResult>
  return {
    sendImportantEmail,
    subscription: await subscribe(
      schema,
      ast || defaultAst,
      data
    ),
  };
}

async function getPromiseException(fn) {
  try {
    await fn();
  } catch(error) {
    return error;
  }
}

async function expectPromiseToThrow(promise, message) {
  let error = await getPromiseException(promise);
  expect(error && error.message).to.equal(message);
}

function expectError(error, message) {
  expect(error instanceof Error).to.equal(true);
  expect(error && error.message).to.equal(message);
}

// Check all error cases when initializing the subscription.
describe('Subscription Initialization Phase', () => {

  it('accepts an object with named properties as arguments', async () => {
    const document = parse(`
      subscription {
        importantEmail
      }
    `);

    async function* emptyAsyncIterator() {
      // Empty
    }

    const ai = await subscribe({
      schema: emailSchema,
      document,
      rootValue: {
        importantEmail: emptyAsyncIterator
      }
    });

    ai.return();
  });

  it('accepts multiple subscription fields defined in schema', async () => {
    const pubsub = new EventEmitter();
    const SubscriptionTypeMultiple = new GraphQLObjectType({
      name: 'Subscription',
      fields: {
        importantEmail: { type: EmailEventType },
        nonImportantEmail: { type: EmailEventType },
      }
    });

    const testSchema = new GraphQLSchema({
      query: QueryType,
      subscription: SubscriptionTypeMultiple
    });

    const {
      subscription,
      sendImportantEmail,
    } = await createSubscription(pubsub, testSchema);

    sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Alright',
      message: 'Tests are good',
      unread: true,
    });

    await subscription.next();
  });

  it('accepts type definition with sync subscribe function', async () => {
    const pubsub = new EventEmitter();
    const emailSchema = new GraphQLSchema({
      query: QueryType,
      subscription: new GraphQLObjectType({
        name: 'Subscription',
        fields: {
          importantEmail: {
            type: GraphQLString,
            subscribe: () => eventEmitterAsyncIterator(pubsub, 'importantEmail')
          },
        }
      })
    });

    const ast = parse(`
      subscription {
        importantEmail
      }
    `);

    const subscription = await subscribe(
      emailSchema,
      ast
    );

    pubsub.emit('importantEmail', {
      importantEmail: {}
    });

    await subscription.next();
  });

  it('accepts type definition with async subscribe function', async () => {
    const pubsub = new EventEmitter();
    const emailSchema = new GraphQLSchema({
      query: QueryType,
      subscription: new GraphQLObjectType({
        name: 'Subscription',
        fields: {
          importantEmail: {
            type: GraphQLString,
            subscribe: async () => {
              await new Promise(setImmediate);
              return eventEmitterAsyncIterator(pubsub, 'importantEmail');
            }
          },
        }
      })
    });

    const ast = parse(`
      subscription {
        importantEmail
      }
    `);

    const subscription = await subscribe(
      emailSchema,
      ast
    );

    pubsub.emit('importantEmail', {
      importantEmail: {}
    });

    await subscription.next();
  });

  it('should only resolve the first field of invalid multi-field', async () => {
    let didResolveImportantEmail = false;
    let didResolveNonImportantEmail = false;

    const SubscriptionTypeMultiple = new GraphQLObjectType({
      name: 'Subscription',
      fields: {
        importantEmail: {
          type: EmailEventType,
          subscribe() {
            didResolveImportantEmail = true;
            return eventEmitterAsyncIterator(new EventEmitter(), 'event');
          }
        },
        nonImportantEmail: {
          type: EmailEventType,
          subscribe() {
            didResolveNonImportantEmail = true;
            return eventEmitterAsyncIterator(new EventEmitter(), 'event');
          }
        },
      }
    });

    const testSchema = new GraphQLSchema({
      query: QueryType,
      subscription: SubscriptionTypeMultiple
    });

    const ast = parse(`
      subscription {
        importantEmail
        nonImportantEmail
      }
    `);

    const subscription = await subscribe(testSchema, ast);
    subscription.next(); // Ask for a result, but ignore it.

    expect(didResolveImportantEmail).to.equal(true);
    expect(didResolveNonImportantEmail).to.equal(false);

    // Close subscription
    subscription.return();
  });

  it('returns an error if schema is missing', async () => {
    const document = parse(`
      subscription {
        importantEmail
      }
    `);

    expectError(
      await subscribe(null, document),
      'Must provide schema',
    );

    expectError(
      await subscribe({ document }),
      'Must provide schema',
    );
  });

  it('returns an error if document is missing', async () => {
    expectError(
      await subscribe(emailSchema, null),
      'Must provide document'
    );

    expectError(
      await subscribe({ schema: emailSchema }),
      'Must provide document'
    );
  });

  it('returns an error for unknown root field', async () => {
    const ast = parse(`
      subscription {
        unknownField
      }
    `);

    const pubsub = new EventEmitter();

    const { subscription } = await createSubscription(
      pubsub,
      emailSchema,
      ast,
    );

    expectError(
      subscription,
      'This subscription is not defined by the schema.'
    );
  });

  it('returns an error if subscribe function returns error', async () => {
    const erroringEmailSchema = emailSchemaWithResolvers(
      () => { return new Error('test error'); }
    );

    const result = await subscribe(
      erroringEmailSchema,
      parse(`
        subscription {
          importantEmail
        }
      `)
    );

    // TODO: is there a good way to check if result is of type ExecutionResult?
    expect(result).to.deep.equal({
      errors: [
        {
          message: 'test error',
          locations: [ { line: 3, column: 11 } ],
          path: [ 'importantEmail' ]
        }
      ]
    });
  });

  it('returns an error if subscribe does not return an iterator', async () => {
    const invalidEmailSchema = new GraphQLSchema({
      query: QueryType,
      subscription: new GraphQLObjectType({
        name: 'Subscription',
        fields: {
          importantEmail: {
            type: GraphQLString,
            subscribe: () => 'test',
          },
        }
      })
    });

    const pubsub = new EventEmitter();

    const { subscription } = await createSubscription(
      pubsub,
      invalidEmailSchema,
    );

    expectError(
      subscription,
      'Subscription must return Async Iterable. Received: test'
    );
  });

  it('returns an ExecutionResult for resolver errors', async () => {
    const erroringEmailSchema = emailSchemaWithResolvers(
      () => { throw new Error('test error'); }
    );

    const result = await subscribe(
      erroringEmailSchema,
      parse(`
        subscription {
          importantEmail
        }
      `)
    );

    // TODO: is there a good way to check if result is of type ExecutionResult?
    expect(result).to.deep.equal({
      errors: [
        {
          message: 'test error',
          locations: [ { line: 3, column: 11 } ],
          path: [ 'importantEmail' ]
        }
      ]
    });
  });
});

// Once a subscription returns a valid AsyncIterator, it can still yield
// errors.
describe('Subscription Publish Phase', () => {

  it('produces a payload for multiple subscribe in same subscription',
    async () => {
      const pubsub = new EventEmitter();
      const {
        sendImportantEmail,
        subscription,
      } = await createSubscription(pubsub);
      const second = await createSubscription(pubsub);

      const payload1 = subscription.next();
      const payload2 = second.subscription.next();

      expect(sendImportantEmail({
        from: 'yuzhi@graphql.org',
        subject: 'Alright',
        message: 'Tests are good',
        unread: true,
      })).to.equal(true);

      const expectedPayload = {
        done: false,
        value: {
          data: {
            importantEmail: {
              email: {
                from: 'yuzhi@graphql.org',
                subject: 'Alright',
              },
              inbox: {
                unread: 1,
                total: 2,
              },
            },
          },
        },
      };

      expect(await payload1).to.deep.equal(expectedPayload);
      expect(await payload2).to.deep.equal(expectedPayload);
    });

  it('produces a payload per subscription event', async () => {
    const pubsub = new EventEmitter();
    const {
      sendImportantEmail,
      subscription,
    } = await createSubscription(pubsub);

    // Wait for the next subscription payload.
    const payload = subscription.next();

    // A new email arrives!
    expect(sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Alright',
      message: 'Tests are good',
      unread: true,
    })).to.equal(true);

    // The previously waited on payload now has a value.
    expect(await payload).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              from: 'yuzhi@graphql.org',
              subject: 'Alright',
            },
            inbox: {
              unread: 1,
              total: 2,
            },
          },
        },
      },
    });

    // Another new email arrives, before subscription.next() is called.
    expect(sendImportantEmail({
      from: 'hyo@graphql.org',
      subject: 'Tools',
      message: 'I <3 making things',
      unread: true,
    })).to.equal(true);

    // The next waited on payload will have a value.
    expect(await subscription.next()).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              from: 'hyo@graphql.org',
              subject: 'Tools',
            },
            inbox: {
              unread: 2,
              total: 3,
            },
          },
        },
      },
    });

    // The client decides to disconnect.
    expect(await subscription.return()).to.deep.equal({
      done: true,
      value: undefined,
    });

    // Which may result in disconnecting upstream services as well.
    expect(sendImportantEmail({
      from: 'adam@graphql.org',
      subject: 'Important',
      message: 'Read me please',
      unread: true,
    })).to.equal(false); // No more listeners.

    // Awaiting a subscription after closing it results in completed results.
    expect(await subscription.next()).to.deep.equal({
      done: true,
      value: undefined,
    });
  });

  it('produces a payload when there are multiple events', async () => {
    const pubsub = new EventEmitter();
    const {
      sendImportantEmail,
      subscription,
    } = await createSubscription(pubsub);
    let payload = subscription.next();

    // A new email arrives!
    expect(sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Alright',
      message: 'Tests are good',
      unread: true,
    })).to.equal(true);

    expect(await payload).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              from: 'yuzhi@graphql.org',
              subject: 'Alright',
            },
            inbox: {
              unread: 1,
              total: 2,
            },
          },
        },
      },
    });

    payload = subscription.next();

    // A new email arrives!
    expect(sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Alright 2',
      message: 'Tests are good 2',
      unread: true,
    })).to.equal(true);

    expect(await payload).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              from: 'yuzhi@graphql.org',
              subject: 'Alright 2',
            },
            inbox: {
              unread: 2,
              total: 3,
            },
          },
        },
      },
    });
  });

  it('should not trigger when subscription is already done', async () => {
    const pubsub = new EventEmitter();
    const {
      sendImportantEmail,
      subscription,
    } = await createSubscription(pubsub);
    let payload = subscription.next();

    // A new email arrives!
    expect(sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Alright',
      message: 'Tests are good',
      unread: true,
    })).to.equal(true);

    expect(await payload).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              from: 'yuzhi@graphql.org',
              subject: 'Alright',
            },
            inbox: {
              unread: 1,
              total: 2,
            },
          },
        },
      },
    });

    payload = subscription.next();
    subscription.return();

    // A new email arrives!
    expect(sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Alright 2',
      message: 'Tests are good 2',
      unread: true,
    })).to.equal(false);

    expect(await payload).to.deep.equal({
      done: true,
      value: undefined,
    });
  });

  it('event order is correct for multiple publishes', async () => {
    const pubsub = new EventEmitter();
    const {
      sendImportantEmail,
      subscription,
    } = await createSubscription(pubsub);
    let payload = subscription.next();

    // A new email arrives!
    expect(sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Message',
      message: 'Tests are good',
      unread: true,
    })).to.equal(true);

    // A new email arrives!
    expect(sendImportantEmail({
      from: 'yuzhi@graphql.org',
      subject: 'Message 2',
      message: 'Tests are good 2',
      unread: true,
    })).to.equal(true);

    expect(await payload).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              from: 'yuzhi@graphql.org',
              subject: 'Message',
            },
            inbox: {
              unread: 2,
              total: 3,
            },
          },
        },
      },
    });

    payload = subscription.next();

    expect(await payload).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              from: 'yuzhi@graphql.org',
              subject: 'Message 2',
            },
            inbox: {
              unread: 2,
              total: 3,
            },
          },
        },
      },
    });
  });

  it('should handle error during execuction of source event', async () => {
    const erroringEmailSchema = emailSchemaWithResolvers(
      async function* () {
        yield { email: { subject: 'Hello' } };
        yield { email: { subject: 'Goodbye' } };
        yield { email: { subject: 'Bonjour' } };
      },
      event => {
        if (event.email.subject === 'Goodbye') {
          throw new Error('Never leave.');
        }
        return event;
      }
    );

    const subscription = await subscribe(
      erroringEmailSchema,
      parse(`
        subscription {
          importantEmail {
            email {
              subject
            }
          }
        }
      `)
    );

    const payload1 = await subscription.next();
    expect(payload1).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              subject: 'Hello'
            }
          }
        }
      }
    });

    // An error in execution is presented as such.
    const payload2 = await subscription.next();
    expect(payload2).to.deep.equal({
      done: false,
      value: {
        errors: [
          {
            message: 'Never leave.',
            locations: [ { line: 3, column: 11 } ],
            path: [ 'importantEmail' ],
          }
        ],
        data: {
          importantEmail: null,
        }
      }
    });

    // However that does not close the response event stream. Subsequent
    // events are still executed.
    const payload3 = await subscription.next();
    expect(payload3).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              subject: 'Bonjour'
            }
          }
        }
      }
    });

  });

  it('should pass through error thrown in source event stream', async () => {
    const erroringEmailSchema = emailSchemaWithResolvers(
      async function* () {
        yield { email: { subject: 'Hello' } };
        throw new Error('test error');
      },
      email => email
    );

    const subscription = await subscribe(
      erroringEmailSchema,
      parse(`
        subscription {
          importantEmail {
            email {
              subject
            }
          }
        }
      `)
    );

    const payload1 = await subscription.next();
    expect(payload1).to.deep.equal({
      done: false,
      value: {
        data: {
          importantEmail: {
            email: {
              subject: 'Hello'
            }
          }
        }
      }
    });

    let expectedError;
    try {
      await subscription.next();
    } catch (error) {
      expectedError = error;
    }

    expect(expectedError).to.deep.equal(new Error('test error'));

    const payload2 = await subscription.next();
    expect(payload2).to.deep.equal({
      done: true,
      value: undefined
    });
  });
});
