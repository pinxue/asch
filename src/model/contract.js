module.exports = {
    table: 'contracts',
    tableFields: [
      { name: 'id', type: 'Number', primary_key: true },
      { name: 'tid', type: 'String', length: 64, not_null: true, unique: true },
      { name: 'name', type: 'String', length: 32, not_null: true, unique: true },
      { name: 'address', type: 'String', length: 50, unique: true },
      { name: 'owner', type: 'String', length: 50, not_null: true, index: true },
      { name: 'desc', type: 'String', length: 255 },
      { name: 'vmVersion', type: 'String', length: 32 },
      { name: 'code', type: 'Text', not_null: true },
      { name: 'metadata', type: 'Json', not_null: true },
      { name: 'timestamp', type: 'Number', not_null: true }
    ]
  }
  