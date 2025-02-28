/*
 *                      Copyright 2024 Salto Labs Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ElemID, InstanceElement, ObjectType, toChange } from '@salto-io/adapter-api'
import axios from 'axios'
import MockAdapter from 'axios-mock-adapter'
import { organizationExistenceValidator } from '../../src/change_validators'
import { SLA_POLICY_TYPE_NAME, ZENDESK } from '../../src/constants'
import ZendeskClient from '../../src/client/client'
import { DEFAULT_CONFIG, FETCH_CONFIG } from '../../src/config'
import { getOrganizationsByIds } from '../../src/filters/organizations'

const logTrace = jest.fn()
jest.mock('@salto-io/logging', () => {
  const actual = jest.requireActual('@salto-io/logging')
  return {
    ...actual,
    logger: () => ({ ...actual.logger('test'), trace: (...args: unknown[]) => logTrace(args) }),
  }
})

describe('OrganizationExistence', () => {
  const slaType = new ObjectType({ elemID: new ElemID(ZENDESK, SLA_POLICY_TYPE_NAME) })
  const triggerType = new ObjectType({ elemID: new ElemID(ZENDESK, 'trigger') })

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const createOrgsList = (ids = true) => ({
    all: [
      {
        field: 'organization_id',
        operator: 'is',
        value: ids ? 1 : 'one',
      },
      {
        field: 'organization_id',
        operator: 'is',
        value: ids ? 2 : 'two',
      },
      {
        field: 'organization_id',
        operator: 'is',
        value: ids ? 3 : 'three',
      },
      {
        field: 'organization_id',
        operator: 'is',
        value: ids ? 4 : 'four',
      },
      {
        field: 'organization_id',
        operator: 'is',
        value: ids ? 4 : 'four', // Twice to make sure it is not duplicated in the error message
      },
    ],
  })

  const createSlaInstance = (ids = true): InstanceElement =>
    new InstanceElement('sla', slaType, { filter: createOrgsList(ids) })

  const createTriggerInstance = (ids = true): InstanceElement =>
    new InstanceElement('trigger', triggerType, { conditions: createOrgsList(ids) })

  let mockAxios: MockAdapter
  let client: ZendeskClient
  beforeEach(() => {
    mockAxios = new MockAdapter(axios)
    client = new ZendeskClient({ credentials: { username: 'a', password: 'b', subdomain: 'ignore' } })
    logTrace.mockReset()
  })

  afterEach(() => {
    mockAxios.restore()
  })

  it('should return an error if the organization does not exist, with resolved Ids', async () => {
    const fetchConfig = { ...DEFAULT_CONFIG[FETCH_CONFIG], resolveOrganizationIDs: true }
    const resolvedIdsClient = new ZendeskClient({
      credentials: { username: 'a', password: 'b', subdomain: 'ignore' },
      allowOrganizationNames: true,
    })
    const validator = organizationExistenceValidator(resolvedIdsClient, fetchConfig)
    mockAxios.onGet().reply(() => [
      200,
      {
        organizations: [
          { id: 1, name: 'one' },
          { id: 2, name: 'two' },
        ],
      },
    ])

    const slaInstance = createSlaInstance(false)
    const triggerInstance = createTriggerInstance(false)

    const changes = [
      toChange({ after: slaInstance }),
      toChange({ before: triggerInstance, after: triggerInstance }),
      toChange({ before: slaInstance }), // Should do nothing because we don't care about removals
    ]

    const errors = await validator(changes)
    expect(errors).toMatchObject([
      {
        elemID: slaInstance.elemID,
        severity: 'Error',
        message: 'Referenced organizations do not exist',
        detailedMessage: 'The following referenced organizations do not exist in the target environment: three, four',
      },
      {
        elemID: triggerInstance.elemID,
        severity: 'Error',
        message: 'Referenced organizations do not exist',
        detailedMessage: 'The following referenced organizations do not exist in the target environment: three, four',
      },
    ])
  })
  it('should return a warning if the organization does not exist, with resolved Ids and createMissingOrganizations is on', async () => {
    const fetchConfig = { ...DEFAULT_CONFIG[FETCH_CONFIG], resolveOrganizationIDs: true }
    const deployConfig = { createMissingOrganizations: true }
    const resolvedIdsClient = new ZendeskClient({
      credentials: { username: 'a', password: 'b', subdomain: 'ignore' },
      allowOrganizationNames: true,
    })
    const validator = organizationExistenceValidator(resolvedIdsClient, fetchConfig, deployConfig)
    mockAxios.onGet().reply(() => [
      200,
      {
        organizations: [
          { id: 1, name: 'one' },
          { id: 2, name: 'two' },
        ],
      },
    ])

    const slaInstance = createSlaInstance(false)
    const triggerInstance = createTriggerInstance(false)

    const changes = [
      toChange({ after: slaInstance }),
      toChange({ before: triggerInstance, after: triggerInstance }),
      toChange({ before: slaInstance }), // Should do nothing because we don't care about removals
    ]

    const errors = await validator(changes)
    expect(errors).toMatchObject([
      {
        elemID: slaInstance.elemID,
        severity: 'Warning',
        message: 'Referenced organizations do not exist and will be created',
        detailedMessage:
          'The following organizations are referenced but do not exist in the target environment: three, four\nIf you continue, they will be created.',
      },
      {
        elemID: triggerInstance.elemID,
        severity: 'Warning',
        message: 'Referenced organizations do not exist and will be created',
        detailedMessage:
          'The following organizations are referenced but do not exist in the target environment: three, four\nIf you continue, they will be created.',
      },
    ])
  })

  it('should return an error if the organization does not exist, and request all orgs in one request, with unresolved Ids', async () => {
    const deployConfig = { createMissingOrganizations: true }
    const validator = organizationExistenceValidator(client, DEFAULT_CONFIG[FETCH_CONFIG], deployConfig)
    mockAxios
      .onGet()
      .replyOnce(200)
      .onGet()
      .replyOnce(200, {
        organizations: [
          { id: 1, name: 'one' },
          { id: 2, name: 'two' },
        ],
      })
      .onGet()
      .replyOnce(401) // Makes sure that there is only one request

    const slaInstance = createSlaInstance()
    const triggerInstance = createTriggerInstance()

    const changes = [
      toChange({ after: slaInstance }),
      toChange({ before: triggerInstance, after: triggerInstance }),
      toChange({ before: slaInstance }), // Should do nothing because we don't care about removals
    ]

    const errors = await validator(changes)
    expect(errors).toMatchObject([
      {
        elemID: slaInstance.elemID,
        severity: 'Error',
        message: 'Referenced organizations do not exist',
        detailedMessage:
          "The following referenced organizations do not exist in the target environment: 3, 4. Salto can identify organizations by their names. This requires setting the 'resolveOrganizationIDs' to true in the zendesk configuration file of both source and target envs and fetch.\n" +
          "More information about Salto's config files can be found here: 'https://help.salto.io/en/articles/7439324-salto-configuration-file'",
      },
      {
        elemID: triggerInstance.elemID,
        severity: 'Error',
        message: 'Referenced organizations do not exist',
        detailedMessage:
          "The following referenced organizations do not exist in the target environment: 3, 4. Salto can identify organizations by their names. This requires setting the 'resolveOrganizationIDs' to true in the zendesk configuration file of both source and target envs and fetch.\n" +
          "More information about Salto's config files can be found here: 'https://help.salto.io/en/articles/7439324-salto-configuration-file'",
      },
    ])
  })
  it('should not crash if the request for organizations fails', async () => {
    const validator = organizationExistenceValidator(client, DEFAULT_CONFIG[FETCH_CONFIG])
    mockAxios.onGet().reply(404)

    const slaInstance = createSlaInstance()
    const changes = [toChange({ after: slaInstance })]

    const errors = await validator(changes)
    expect(errors.length).toBe(0)
  })
  it('should filter organization names from the logs with unresolved Ids', async () => {
    mockAxios.onGet().reply(200, {
      organizations: [
        { id: 1, name: 'one' },
        { id: 2, name: 'two' },
      ],
    })
    await getOrganizationsByIds(['1', '2'], client)

    expect(logTrace).toHaveBeenCalledWith([
      'Full HTTP response for %s on %s: %s',
      'GET',
      '/api/v2/organizations/show_many?ids=1,2',
      '{"url":"/api/v2/organizations/show_many?ids=1,2","method":"GET","status":200,"response":{"organizations":[{"id":1,"name":"<OMITTED>"},{"id":2,"name":"<OMITTED>"}]}}',
    ])
  })
})
